import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CredentialManager } from '../connectors/credential-manager';
import { generateMasterKey } from '../connectors/credential-encryption';
import { ApolloSourcingProvider } from '../connectors/sourcing/apollo-sourcing.provider';
import { SourcingUnavailableError } from '../connectors/sourcing/sourcing-provider';
import type {
  ApolloOrganization,
  ApolloOrgSearchParams,
} from '../connectors/adapters/apollo/apollo.source';
import type { ApolloOrgSearcher } from '../connectors/sourcing/apollo-sourcing.provider';
import type { IcpCriteria } from '../connectors/sourcing/sourcing-provider';
import { buildSourcingProvider } from './campaign.worker';

/**
 * Integration coverage for the Apollo sourcing path against real Postgres + the
 * real CredentialManager. The unit tests stub credential loading; this proves
 * the cross-cutting pieces: ConnectorAccount lookup, the encrypt→decrypt
 * round-trip of the BYO key, provider construction, and graceful failure when
 * the account is missing / expired. The Apollo HTTP adapter is stubbed so the
 * suite stays hermetic (no real Apollo calls).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const ICP: IcpCriteria = {
  keywords: ['devtools'],
  employeeCountMin: 1,
  employeeCountMax: 50,
  fundingStages: ['seed'],
  industries: ['software'],
  locations: ['United States'],
};

/** A stub Apollo adapter that records params and yields the given orgs. */
function stubAdapter(orgs: ApolloOrganization[]): {
  adapter: ApolloOrgSearcher;
  lastParams: () => ApolloOrgSearchParams | undefined;
} {
  let captured: ApolloOrgSearchParams | undefined;
  return {
    adapter: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *searchOrganizations(params) {
        captured = params;
        for (const o of orgs) yield o;
      },
    },
    lastParams: () => captured,
  };
}

function org(overrides: Partial<ApolloOrganization> = {}): ApolloOrganization {
  return {
    externalId: 'o1',
    name: 'Acme Inc',
    domain: 'acme.com',
    linkedinUrl: null,
    employeeCount: 20,
    fundingStage: 'Seed',
    raw: {},
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)(
  'campaign Apollo sourcing (integration — needs live Postgres)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let prismaService: PrismaService;
    let credentials: CredentialManager;
    let orgId: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}".`,
        );
      }
      process.env.CREDENTIAL_MASTER_KEY = generateMasterKey();
      process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
      process.env.BRAVE_SEARCH_API_KEY ||= 'test-brave-key';

      const { AppModule } = await import('../../app.module');
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      credentials = app.get(CredentialManager);
      prismaService = app.get(PrismaService);
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
    });

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
      credentials.resetForTests();
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE connector_accounts, organizations
        RESTART IDENTITY CASCADE
      `);
      const o = await prisma.organization.create({ data: { name: 'OrgA' } });
      orgId = o.id;
    });

    async function connectApollo(apiKey = 'apollo-key'): Promise<string> {
      return credentials.persistInitialCredentials({
        orgId,
        kind: 'apollo',
        authMode: 'byo_key',
        creds: { apiKey },
      });
    }

    it('builds an ApolloSourcingProvider that discovers companies (real decrypt round-trip)', async () => {
      await connectApollo();
      const { adapter, lastParams } = stubAdapter([
        org({ externalId: 'o1', domain: 'acme.com' }),
        org({ externalId: 'o2', domain: 'beta.io', name: 'Beta' }),
      ]);

      const provider = await buildSourcingProvider(
        prismaService,
        credentials,
        orgId,
        { provider: 'apollo' },
        adapter,
      );
      expect(provider).toBeInstanceOf(ApolloSourcingProvider);

      const result = await provider!.findCandidates(ICP, { limit: 10 });
      expect(result.candidates.map((c) => c.name)).toEqual(['Acme Inc', 'Beta']);
      // The decrypted key reached the adapter, and the ICP became the query.
      expect(lastParams()?.creds).toEqual({ apiKey: 'apollo-key' });
      expect(
        lastParams()?.config.search.companyHeadcount,
      ).toEqual({ min: 1, max: 50 });
    });

    it('auto-discovers via Apollo when no source is attached but Apollo is connected', async () => {
      await connectApollo();
      const { adapter } = stubAdapter([org()]);
      const provider = await buildSourcingProvider(
        prismaService,
        credentials,
        orgId,
        null,
        adapter,
      );
      expect(provider).toBeInstanceOf(ApolloSourcingProvider);
    });

    it('throws SourcingUnavailableError when Apollo is not connected', async () => {
      const { adapter } = stubAdapter([]);
      await expect(
        buildSourcingProvider(prismaService, credentials, orgId, {
          provider: 'apollo',
        }, adapter),
      ).rejects.toBeInstanceOf(SourcingUnavailableError);
    });

    it('surfaces a reconnect message when the Apollo key is expired', async () => {
      const accountId = await connectApollo();
      await prisma.connectorAccount.update({
        where: { id: accountId },
        data: { status: 'expired' },
      });
      const { adapter } = stubAdapter([]);

      await expect(
        buildSourcingProvider(prismaService, credentials, orgId, {
          provider: 'apollo',
        }, adapter),
      ).rejects.toThrow(/reconnect Apollo/i);
    });
  },
);
