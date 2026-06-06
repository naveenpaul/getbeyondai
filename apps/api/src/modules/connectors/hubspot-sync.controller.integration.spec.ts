import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the HubSpot SDK at the module boundary so the integration test
 * never reaches the network. Configured per-test to script vendor responses.
 *
 * Hoisted: vi.mock factories run before module-level consts, so the spy
 * functions are declared via vi.hoisted.
 */
const { hubspotMocks } = vi.hoisted(() => ({
  hubspotMocks: {
    listsDoSearch: vi.fn(),
    membershipsGetPage: vi.fn(),
    contactsBatchRead: vi.fn(),
    oauthTokensCreate: vi.fn(),
    oauthAccessTokensGet: vi.fn(),
  },
}));

vi.mock('@hubspot/api-client', () => {
  class FakeClient {
    constructor(_opts?: { accessToken?: string }) {}
    crm = {
      contacts: { batchApi: { read: hubspotMocks.contactsBatchRead } },
      lists: {
        listsApi: { doSearch: hubspotMocks.listsDoSearch },
        membershipsApi: { getPage: hubspotMocks.membershipsGetPage },
      },
    };
    oauth = {
      tokensApi: { create: hubspotMocks.oauthTokensCreate },
      accessTokensApi: { get: hubspotMocks.oauthAccessTokensGet },
    };
  }
  return { Client: FakeClient };
});

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { createAuth } from '../auth/auth.config';
import { createTestSession } from '../auth/test-session';
import { generateMasterKey } from './credential-encryption';
import type { HubspotSyncRunStatusResponse } from './hubspot-sync.dto';

const DATABASE_URL = process.env.DATABASE_URL;
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

describe.skipIf(!DATABASE_URL)(
  'HubspotSyncController (integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let credentialManager: import('./credential-manager').CredentialManager;
    let auth: Awaited<ReturnType<typeof createAuth>>;
    let alice: { cookie: string; userId: string; orgId: string };
    let bob: { cookie: string; userId: string; orgId: string };
    let hubspotAccountA: string;
    let hubspotAccountB: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}".`,
        );
      }
      process.env.CREDENTIAL_MASTER_KEY = generateMasterKey();
      process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
      process.env.SEARXNG_URL ||= 'http://searxng.test';
      process.env.HUBSPOT_CLIENT_ID = 'client-id-test';
      process.env.HUBSPOT_CLIENT_SECRET = 'client-secret-test';
      process.env.AUTH_SECRET = 'test-auth-secret-32-chars-padding-to-match';

      const { AppModule } = await import('../../app.module');
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      const { CredentialManager } = await import('./credential-manager');
      credentialManager = app.get(CredentialManager);
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
      auth = await createAuth(prisma);
    });

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
      // resetAllMocks clears BOTH call history and any leftover queued
      // *Once implementations from prior tests. clearAllMocks alone
      // leaves Once queues intact, which can shift a 5xx mock past a
      // stale resolved value from the previous test.
      vi.resetAllMocks();
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          draft_actions, claims, drafts,
          contact_sources, contact_emails, contact_list_members, contact_lists,
          contacts, sync_runs, oauth_states, connector_accounts,
          tool_calls, model_calls, citations, agent_runs,
          voices, company_brains, sessions, accounts, verifications, org_memberships,
          users, organizations
        RESTART IDENTITY CASCADE
      `);
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE pgboss.job, pgboss.archive RESTART IDENTITY`,
        )
        .catch(() => {});

      // Magic-link signup auto-creates Org A + Org B via the user.create
      // hook. Subsequent calls return the existing session for that user.
      alice = await createTestSession(prisma, auth, 'alice@test.com');
      bob = await createTestSession(prisma, auth, 'bob@test.com');

      hubspotAccountA = await credentialManager.persistInitialCredentials({
        orgId: alice.orgId,
        kind: 'hubspot',
        authMode: 'oauth',
        creds: {
          accessToken: 'tok-A',
          refreshToken: 'r-A',
          hubId: 1111,
        },
        scopes: ['oauth', 'crm.objects.contacts.read', 'crm.lists.read'],
      });
      hubspotAccountB = await credentialManager.persistInitialCredentials({
        orgId: bob.orgId,
        kind: 'hubspot',
        authMode: 'oauth',
        creds: { accessToken: 'tok-B', refreshToken: 'r-B', hubId: 2222 },
      });
    });

    async function postSync(body: Record<string, unknown>, cookie: string) {
      return app.inject({
        method: 'POST',
        url: '/connectors/hubspot/sync',
        payload: body,
        headers: { 'content-type': 'application/json', cookie },
      });
    }

    async function pollUntilDone(
      syncRunId: string,
      cookie: string,
    ): Promise<HubspotSyncRunStatusResponse> {
      const start = Date.now();
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        const res = await app.inject({
          method: 'GET',
          url: `/connectors/hubspot/sync-runs/${syncRunId}`,
          headers: { cookie },
        });
        if (res.statusCode === 200) {
          const body = res.json() as HubspotSyncRunStatusResponse;
          if (body.status === 'completed' || body.status === 'failed') {
            return body;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      throw new Error(
        `SyncRun ${syncRunId} did not terminate in ${POLL_TIMEOUT_MS}ms`,
      );
    }

    // ─── POST /connectors/hubspot/sync — happy path ──────────────────

    it('happy path: 202 → worker pulls 2 contacts → both upserted', async () => {
      hubspotMocks.membershipsGetPage.mockResolvedValueOnce({
        results: [{ recordId: 101 }, { recordId: 102 }],
        paging: undefined,
      });
      hubspotMocks.contactsBatchRead.mockResolvedValueOnce({
        results: [
          {
            id: '101',
            properties: {
              email: 'sasha@example.com',
              firstname: 'Sasha',
              lastname: 'Lin',
              company: 'Acme',
            },
          },
          {
            id: '102',
            properties: {
              email: 'marcus@example.com',
              firstname: 'Marcus',
            },
          },
        ],
      });

      const res = await postSync({ connectorAccountId: hubspotAccountA,
        listId: 'list-42', }, alice.cookie);
      expect(res.statusCode).toBe(202);
      const body = res.json() as { syncRunId: string; status: string };
      expect(body.status).toBe('running');

      const finalState = await pollUntilDone(body.syncRunId, alice.cookie);
      expect(finalState.status).toBe('completed');
      expect(finalState.recordsIn).toBe(2);
      expect(finalState.recordsOut).toBe(2);
      expect(finalState.errorCount).toBe(0);

      // Contacts persisted with HubSpot provenance.
      const contacts = await prisma.contact.findMany({
        where: { orgId: alice.orgId },
        include: { sources: true },
      });
      expect(contacts).toHaveLength(2);
      const sasha = contacts.find((c) => c.firstName === 'Sasha');
      expect(sasha?.company).toBe('Acme');
      expect(sasha?.sources[0]?.sourceAccountId).toBe(hubspotAccountA);
      expect(sasha?.sources[0]?.externalId).toBe('101');

      // ConnectorAccount.lastSyncAt populated.
      const acct = await prisma.connectorAccount.findUnique({
        where: { id: hubspotAccountA },
      });
      expect(acct?.lastSyncAt).toBeInstanceOf(Date);
    });

    it('paginated sync: two pages → all contacts upserted', async () => {
      hubspotMocks.membershipsGetPage
        .mockResolvedValueOnce({
          results: [{ recordId: 1 }, { recordId: 2 }],
          paging: { next: { after: 'page-2' } },
        })
        .mockResolvedValueOnce({
          results: [{ recordId: 3 }],
          paging: undefined,
        });
      hubspotMocks.contactsBatchRead
        .mockResolvedValueOnce({
          results: [
            { id: '1', properties: { email: 'a@x.com' } },
            { id: '2', properties: { email: 'b@x.com' } },
          ],
        })
        .mockResolvedValueOnce({
          results: [{ id: '3', properties: { email: 'c@x.com' } }],
        });

      const res = await postSync({ connectorAccountId: hubspotAccountA,
        listId: 'list-multi', }, alice.cookie);
      const body = res.json() as { syncRunId: string };
      const finalState = await pollUntilDone(body.syncRunId, alice.cookie);

      expect(finalState.status).toBe('completed');
      expect(finalState.recordsIn).toBe(3);
      expect(finalState.recordsOut).toBe(3);
      // Both pages of memberships fetched.
      expect(hubspotMocks.membershipsGetPage).toHaveBeenCalledTimes(2);
    });

    it('skips contacts missing an email property', async () => {
      hubspotMocks.membershipsGetPage.mockResolvedValueOnce({
        results: [{ recordId: 1 }, { recordId: 2 }],
        paging: undefined,
      });
      hubspotMocks.contactsBatchRead.mockResolvedValueOnce({
        results: [
          { id: '1', properties: { email: 'a@x.com' } },
          { id: '2', properties: { firstname: 'No-Email' } },
        ],
      });

      const res = await postSync({ connectorAccountId: hubspotAccountA,
        listId: 'list-1', }, alice.cookie);
      const body = res.json() as { syncRunId: string };
      const finalState = await pollUntilDone(body.syncRunId, alice.cookie);
      expect(finalState.status).toBe('completed');
      expect(finalState.recordsIn).toBe(1);
      expect(finalState.recordsOut).toBe(1);
      const count = await prisma.contact.count({ where: { orgId: alice.orgId } });
      expect(count).toBe(1);
    });

    // ─── POST /connectors/hubspot/sync — validation ──────────────────

    it('rejects an unknown connectorAccountId → 404', async () => {
      const res = await postSync({ connectorAccountId: 'does-not-exist',
        listId: 'list-1', }, alice.cookie);
      expect(res.statusCode).toBe(404);
    });

    it('rejects a connectorAccount that belongs to another org → 403', async () => {
      const res = await postSync({ connectorAccountId: hubspotAccountB,
        listId: 'list-1', }, alice.cookie);
      expect(res.statusCode).toBe(403);
    });

    it('rejects a non-hubspot account (e.g. csv) → 400', async () => {
      const csvAccount = await prisma.connectorAccount.create({
        data: {
          orgId: alice.orgId,
          kind: 'csv',
          authMode: 'upload',
          credentials: Buffer.from(''),
        },
      });
      const res = await postSync({ connectorAccountId: csvAccount.id,
        listId: 'list-1', }, alice.cookie);
      expect(res.statusCode).toBe(400);
    });

    it('rejects an expired account → 400 (must reconnect)', async () => {
      await prisma.connectorAccount.update({
        where: { id: hubspotAccountA },
        data: { status: 'expired' },
      });
      const res = await postSync({ connectorAccountId: hubspotAccountA,
        listId: 'list-1', }, alice.cookie);
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing listId → 400', async () => {
      const res = await postSync({ connectorAccountId: hubspotAccountA, }, alice.cookie);
      expect(res.statusCode).toBe(400);
    });

    // ─── GET /connectors/hubspot/sync-runs/:id — tenant guards ─────

    it('GET sync-runs/:id refuses cross-org access → 403', async () => {
      hubspotMocks.membershipsGetPage.mockResolvedValueOnce({
        results: [],
        paging: undefined,
      });
      const res = await postSync(
        { connectorAccountId: hubspotAccountA, listId: 'l' },
        alice.cookie,
      );
      const { syncRunId } = res.json() as { syncRunId: string };
      // Bob signed in → tries to read alice's sync run.
      const cross = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/sync-runs/${syncRunId}`,
        headers: { cookie: bob.cookie },
      });
      expect(cross.statusCode).toBe(403);
    });

    it('GET sync-runs/:id without session → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/hubspot/sync-runs/anything',
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET sync-runs/:id returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/hubspot/sync-runs/cuid_does_not_exist',
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    // ─── Worker error surfacing ──────────────────────────────────────

    it('vendor 5xx during sync → SyncRun status=failed with fatal reason', async () => {
      const err = new Error('Service Unavailable') as Error & { code: number };
      err.code = 503;
      hubspotMocks.membershipsGetPage.mockRejectedValueOnce(err);

      const res = await postSync({ connectorAccountId: hubspotAccountA,
        listId: 'list-bad', }, alice.cookie);
      const { syncRunId } = res.json() as { syncRunId: string };
      const finalState = await pollUntilDone(syncRunId, alice.cookie);
      expect(finalState.status).toBe('failed');
      expect(finalState.errors.at(-1)?.reason).toBe('fatal');
    });
  },
);
