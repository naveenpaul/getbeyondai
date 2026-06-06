import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { generateMasterKey } from './credential-encryption';
import {
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_OPEN_THRESHOLD,
} from './circuit-breaker';
import {
  CredentialManager,
  CredentialManagerError,
  RefreshRejectedError,
} from './credential-manager';
import type {
  CredentialUpdate,
  DecryptedCredentials,
} from '@getbeyond/shared';

/**
 * Integration coverage for the CredentialManager against real Postgres
 * (T3c.6). Unit-level behavior is in credential-manager.spec.ts; this
 * suite proves the cross-cutting pieces — CAS under concurrency, status
 * transitions persisted, circuit half-open survives process boundary.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'CredentialManager (integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let manager: CredentialManager;
    let orgA: string;

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

      const { AppModule } = await import('../../app.module');
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      manager = app.get(CredentialManager);
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
      manager.resetForTests();
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          draft_actions, claims, drafts,
          contact_sources, contact_emails, contact_list_members, contact_lists,
          contacts, sync_runs, oauth_states, connector_accounts,
          tool_calls, model_calls, citations, agent_runs,
          voices, company_brains, users, organizations
        RESTART IDENTITY CASCADE
      `);
      const o = await prisma.organization.create({ data: { name: 'OrgA' } });
      orgA = o.id;
    });

    async function seedAccount(creds: DecryptedCredentials): Promise<string> {
      return manager.persistInitialCredentials({
        orgId: orgA,
        kind: 'hubspot',
        authMode: 'oauth',
        creds,
        scopes: ['oauth'],
      });
    }

    // ─── persistInitialCredentials ───────────────────────────────────

    it('persistInitialCredentials encrypts at rest + sets version=1', async () => {
      const accountId = await seedAccount({
        accessToken: 'tok-1',
        refreshToken: 'r-1',
      });
      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.credentialsVersion).toBe(1);
      expect(row?.status).toBe('active');
      expect(Buffer.isBuffer(row?.credentials)).toBe(true);
      expect(row?.credentials.toString('utf8')).not.toContain('tok-1');
    });

    it('persistInitialCredentials on a reconnect rotates creds + bumps version', async () => {
      const id1 = await seedAccount({ accessToken: 'tok-1', refreshToken: 'r-1' });
      const id2 = await seedAccount({ accessToken: 'tok-2', refreshToken: 'r-2' });
      expect(id2).toBe(id1); // upsert on (orgId, kind)

      const row = await prisma.connectorAccount.findUnique({
        where: { id: id1 },
      });
      expect(row?.credentialsVersion).toBe(2);
    });

    // ─── load ───────────────────────────────────────────────────────

    it('load decrypts active account; returns the original plaintext', async () => {
      const accountId = await seedAccount({
        accessToken: 'tok-1',
        refreshToken: 'r-1',
        hubId: 1234,
      });
      const creds = await manager.load(accountId);
      expect(creds).toEqual({
        accessToken: 'tok-1',
        refreshToken: 'r-1',
        hubId: 1234,
      });
    });

    it('load throws expired for status=expired accounts', async () => {
      const accountId = await seedAccount({ accessToken: 'x', refreshToken: 'y' });
      await prisma.connectorAccount.update({
        where: { id: accountId },
        data: { status: 'expired' },
      });
      try {
        await manager.load(accountId);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as CredentialManagerError).code).toBe('expired');
      }
    });

    // ─── refresh (singleflight + CAS) ───────────────────────────────

    it('parallel refresh calls trigger the refresher exactly once', async () => {
      const accountId = await seedAccount({
        accessToken: 'tok-1',
        refreshToken: 'r-1',
      });

      const refresher = vi.fn(async (): Promise<CredentialUpdate> => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          next: { accessToken: 'tok-2', refreshToken: 'r-2' },
          expiresAt: new Date(Date.now() + 1800_000).toISOString(),
        };
      });

      const [a, b, c] = await Promise.all([
        manager.refresh(accountId, refresher),
        manager.refresh(accountId, refresher),
        manager.refresh(accountId, refresher),
      ]);

      expect(refresher).toHaveBeenCalledTimes(1);
      expect(a).toEqual({ accessToken: 'tok-2', refreshToken: 'r-2' });
      expect(b).toEqual(a);
      expect(c).toEqual(a);

      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.credentialsVersion).toBe(2);
    });

    it('rotation-lost: RefreshRejectedError → status=expired, version unchanged', async () => {
      const accountId = await seedAccount({
        accessToken: 'tok-1',
        refreshToken: 'r-1',
      });

      try {
        await manager.refresh(accountId, async () => {
          throw new RefreshRejectedError('vendor 400 invalid_grant');
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as CredentialManagerError).code).toBe('refresh_rejected');
      }

      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.status).toBe('expired');
      expect(row?.credentialsVersion).toBe(1);
      expect(row?.lastError).toContain('refresh token rejected');

      // Subsequent load() refuses — user must reconnect.
      try {
        await manager.load(accountId);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as CredentialManagerError).code).toBe('expired');
      }
    });

    // ─── circuit breaker ────────────────────────────────────────────

    it('5xx storm opens the circuit + persists circuitOpenedAt', async () => {
      const accountId = await seedAccount({ accessToken: 't', refreshToken: 'r' });

      for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
        await manager.reportVendorFailure(accountId, 'server_5xx');
      }

      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.status).toBe('circuit_broken');
      expect(row?.circuitOpenedAt).toBeInstanceOf(Date);

      // load() refuses while inside the cooldown window.
      try {
        await manager.load(accountId);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as CredentialManagerError).code).toBe('circuit_broken');
      }
    });

    it('half-open: after cooldown elapses, load() transitions status back to active', async () => {
      const accountId = await seedAccount({ accessToken: 't', refreshToken: 'r' });
      // Plant a circuit_broken state with circuitOpenedAt past the cooldown.
      const stale = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000);
      await prisma.connectorAccount.update({
        where: { id: accountId },
        data: { status: 'circuit_broken', circuitOpenedAt: stale },
      });

      const creds = await manager.load(accountId);
      expect(creds).toEqual({ accessToken: 't', refreshToken: 'r' });

      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.status).toBe('active');
      expect(row?.circuitOpenedAt).toBeNull();
    });

    it('auth_invalid: marks status=expired without breaker accumulation', async () => {
      const accountId = await seedAccount({ accessToken: 't', refreshToken: 'r' });

      await manager.reportVendorFailure(accountId, 'auth_invalid');

      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.status).toBe('expired');
      expect(row?.circuitOpenedAt).toBeNull();
    });

    it('credentials never appear in lastError or circuit-status persistence', async () => {
      const secret = 'leaked-secret-do-not-store';
      const accountId = await seedAccount({
        accessToken: secret,
        refreshToken: 'r',
      });

      // Trigger an opened circuit.
      for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
        await manager.reportVendorFailure(accountId, 'server_5xx');
      }
      // And a rotation-lost (different code path, also writes lastError).
      await manager.persistInitialCredentials({
        orgId: orgA,
        kind: 'hubspot',
        authMode: 'oauth',
        creds: { accessToken: secret, refreshToken: 'r' },
      });
      try {
        await manager.refresh(accountId, async () => {
          throw new RefreshRejectedError();
        });
      } catch {
        // expected
      }

      const row = await prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      expect(row?.lastError ?? '').not.toContain(secret);
      // Sealed bytes don't reveal plaintext either.
      expect(row?.credentials.toString('utf8')).not.toContain(secret);
    });
  },
);
