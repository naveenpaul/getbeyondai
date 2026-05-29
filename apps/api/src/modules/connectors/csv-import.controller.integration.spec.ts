import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { createAuth } from '../auth/auth.config';
import { createTestSession } from '../auth/test-session';
import type { CsvSyncRunStatusResponse } from './csv-import.dto';

/**
 * Integration tests for the async CSV import HTTP layer (T8-CSV.2c.2).
 *
 * Boots the full Nest+Fastify app, registers @fastify/multipart, exercises
 * the full POST → enqueue → worker → poll round-trip.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;
const MULTIPART_LIMIT_BYTES = 50 * 1024 * 1024;
const INLINE_THRESHOLD_BYTES = 1 * 1024 * 1024;

// Default the test env to the local MinIO from docker-compose. If the user
// hasn't started MinIO (`docker compose up -d minio`), the S3-path test will
// fail with a clear "ECONNREFUSED localhost:9000" instead of a mysterious
// hang. The inline-path tests don't touch S3 and pass either way.
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'getbeyond-blobs';
process.env.S3_ACCESS_KEY ??= 'minioadmin';
process.env.S3_SECRET_KEY ??= 'minioadmin';

describe.skipIf(!DATABASE_URL)(
  'POST /connectors/csv/import (async integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let auth: ReturnType<typeof createAuth>;
    let alice: { cookie: string; userId: string; orgId: string };
    let bob: { cookie: string; userId: string; orgId: string };
    let csvAccountA: string;
    let hubspotAccountA: string;
    let csvAccountB: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}".`,
        );
      }

      process.env.CREDENTIAL_MASTER_KEY ??= Buffer.from(
        new Uint8Array(32).fill(7),
      ).toString('base64');
      process.env.AUTH_SECRET ??= 'test-auth-secret-32-chars-padding-to-match';
      process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';
      process.env.BRAVE_SEARCH_API_KEY ??= 'test-brave-key';

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.register(multipart, {
        limits: { fileSize: MULTIPART_LIMIT_BYTES, files: 1, fields: 4 },
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
      auth = createAuth(prisma);
    });

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
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
        .catch(() => {
          // pg-boss schema not yet bootstrapped on the first beforeEach.
        });

      alice = await createTestSession(prisma, auth, 'alice@test.com');
      bob = await createTestSession(prisma, auth, 'bob@test.com');

      csvAccountA = (
        await prisma.connectorAccount.create({
          data: {
            orgId: alice.orgId,
            kind: 'csv',
            authMode: 'upload',
            credentials: Buffer.from(''),
          },
        })
      ).id;
      hubspotAccountA = (
        await prisma.connectorAccount.create({
          data: {
            orgId: alice.orgId,
            kind: 'hubspot',
            authMode: 'oauth',
            credentials: Buffer.from('test-sealed'),
          },
        })
      ).id;
      csvAccountB = (
        await prisma.connectorAccount.create({
          data: {
            orgId: bob.orgId,
            kind: 'csv',
            authMode: 'upload',
            credentials: Buffer.from(''),
          },
        })
      ).id;
    });

    async function postMultipart(
      csv: string | Buffer,
      metadata: Record<string, unknown>,
      cookie: string = alice.cookie,
    ) {
      const form = new FormData();
      form.append(
        'file',
        typeof csv === 'string' ? Buffer.from(csv, 'utf8') : csv,
        { filename: 'leads.csv', contentType: 'text/csv' },
      );
      form.append('metadata', JSON.stringify(metadata));
      return app.inject({
        method: 'POST',
        url: '/connectors/csv/import',
        payload: form.getBuffer(),
        headers: { ...form.getHeaders(), cookie },
      });
    }

    async function pollSyncRunUntilDone(
      syncRunId: string,
      cookie: string,
    ): Promise<CsvSyncRunStatusResponse> {
      const start = Date.now();
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        const res = await app.inject({
          method: 'GET',
          url: `/connectors/csv/sync-runs/${syncRunId}`,
          headers: { cookie },
        });
        if (res.statusCode === 200) {
          const body = res.json() as CsvSyncRunStatusResponse;
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

    // ─── POST /connectors/csv/import ───────────────────────────────────

    it('happy path: 202 → poll GET sync-runs/:id → completed', async () => {
      const csv = [
        'Email,First Name,Company',
        'sarah@acme.com,Sarah,Acme',
        'tom@beta.com,Tom,Beta',
      ].join('\n');

      const res = await postMultipart(csv, {
        sourceAccountId: csvAccountA,
        columnMapping: {
          email: 'Email',
          firstName: 'First Name',
          company: 'Company',
        },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json() as { syncRunId: string; status: string };
      expect(body.status).toBe('running');
      expect(body.syncRunId).toBeTruthy();

      const finalState = await pollSyncRunUntilDone(body.syncRunId, alice.cookie);
      expect(finalState.status).toBe('completed');
      expect(finalState.recordsOut).toBe(2);
      expect(finalState.errorCount).toBe(0);

      const contacts = await prisma.contact.findMany({
        where: { orgId: alice.orgId },
      });
      expect(contacts).toHaveLength(2);
    });

    it('400 when metadata field is missing', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('Email\nx@y.com', 'utf8'), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/connectors/csv/import',
        payload: form.getBuffer(),
        headers: { ...form.getHeaders(), cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('metadata');
    });

    it('400 when file field is missing', async () => {
      const form = new FormData();
      form.append(
        'metadata',
        JSON.stringify({
          sourceAccountId: csvAccountA,
          columnMapping: { email: 'Email' },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/connectors/csv/import',
        payload: form.getBuffer(),
        headers: { ...form.getHeaders(), cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('file');
    });

    it('400 when metadata is malformed JSON', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('Email\nx@y.com', 'utf8'), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
      form.append('metadata', '{invalid json');
      const res = await app.inject({
        method: 'POST',
        url: '/connectors/csv/import',
        payload: form.getBuffer(),
        headers: { ...form.getHeaders(), cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('valid JSON');
    });

    it('400 when metadata fails Zod validation (missing columnMapping.email)', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        sourceAccountId: csvAccountA,
        columnMapping: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('columnMapping.email');
    });

    it('404 when sourceAccountId does not exist', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        sourceAccountId: 'cuid_does_not_exist',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('403 when ConnectorAccount belongs to a different org', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        sourceAccountId: csvAccountB,
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 when ConnectorAccount kind is not csv', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        sourceAccountId: hubspotAccountA,
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('hubspot');
    });

    it('413 when CSV exceeds the multipart upload limit', async () => {
      // Buffer larger than the multipart fileSize limit (50 MB in this run).
      // Test allocates the smallest oversize possible (50 MB + 1 KB).
      const oversized = Buffer.alloc(MULTIPART_LIMIT_BYTES + 1024, 0x61);
      const res = await postMultipart(oversized, {
        sourceAccountId: csvAccountA,
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(413);
    });

    it('S3 spill: files >1 MB route through object storage, worker hydrates from S3', async () => {
      // Header + 2 valid rows + a third row with a 1.2 MB pad column. Total
      // payload is comfortably above the 1 MB inline threshold so the
      // controller spills to S3. The CSV still parses to 3 contacts.
      const pad = 'x'.repeat(1_200_000);
      const csv = [
        'Email,Notes',
        'sarah@acme.com,short',
        'tom@beta.com,short',
        `priya@gamma.org,${pad}`,
      ].join('\n');
      expect(csv.length).toBeGreaterThan(INLINE_THRESHOLD_BYTES);

      const postRes = await postMultipart(csv, {
        sourceAccountId: csvAccountA,
        columnMapping: { email: 'Email' },
      });
      expect(postRes.statusCode).toBe(202);
      const { syncRunId } = postRes.json() as { syncRunId: string };

      const final = await pollSyncRunUntilDone(syncRunId, alice.cookie);
      expect(final.status).toBe('completed');
      expect(final.recordsOut).toBe(3);
      expect(final.errorCount).toBe(0);

      const contacts = await prisma.contact.findMany({
        where: { orgId: alice.orgId },
      });
      expect(contacts).toHaveLength(3);
      expect(contacts.map((c) => c.normalizedEmail).sort()).toEqual([
        'priya@gamma.org',
        'sarah@acme.com',
        'tom@beta.com',
      ]);
    });

    // ─── GET /connectors/csv/sync-runs/:id ─────────────────────────────

    it('GET sync-runs/:id returns full status payload for a completed run', async () => {
      const postRes = await postMultipart('Email\nsarah@acme.com\ntom@beta.com', {
        sourceAccountId: csvAccountA,
        columnMapping: { email: 'Email' },
      });
      const { syncRunId } = postRes.json() as { syncRunId: string };
      const final = await pollSyncRunUntilDone(syncRunId, alice.cookie);

      expect(final.syncRunId).toBe(syncRunId);
      expect(final.status).toBe('completed');
      expect(final.recordsIn).toBe(2);
      expect(final.recordsOut).toBe(2);
      expect(final.errorCount).toBe(0);
      expect(Array.isArray(final.errors)).toBe(true);
    });

    it('GET sync-runs/:id surfaces row-level errors in the response', async () => {
      const csv = ['Email', 'sarah@acme.com', '', 'malformed', 'tom@beta.com'].join(
        '\n',
      );
      const postRes = await postMultipart(csv, {
        sourceAccountId: csvAccountA,
        columnMapping: { email: 'Email' },
      });
      const { syncRunId } = postRes.json() as { syncRunId: string };
      const final = await pollSyncRunUntilDone(syncRunId, alice.cookie);

      expect(final.status).toBe('completed');
      expect(final.recordsOut).toBe(2);
      expect(final.errorCount).toBeGreaterThanOrEqual(1);
      expect(final.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('GET sync-runs/:id returns 401 when no session cookie is sent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/csv/sync-runs/cuid_any',
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET sync-runs/:id returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/csv/sync-runs/cuid_does_not_exist',
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET sync-runs/:id returns 403 when caller org does not match the SyncRun owner', async () => {
      const postRes = await postMultipart('Email\nx@y.com', {
        sourceAccountId: csvAccountA,
        columnMapping: { email: 'Email' },
      });
      const { syncRunId } = postRes.json() as { syncRunId: string };

      const res = await app.inject({
        method: 'GET',
        url: `/connectors/csv/sync-runs/${syncRunId}`,
        headers: { cookie: bob.cookie },
      });
      expect(res.statusCode).toBe(403);
    });

    describe('POST /connectors/csv/account', () => {
      it('creates a CSV ConnectorAccount when none exists for the org', async () => {
        // beforeEach already seeded one for alice — wipe it so we start clean.
        await prisma.connectorAccount.deleteMany({
          where: { orgId: alice.orgId, kind: 'csv' },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/connectors/csv/account',
          headers: { cookie: alice.cookie },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as { id: string };
        expect(body.id).toBeTruthy();

        const row = await prisma.connectorAccount.findUnique({
          where: { id: body.id },
        });
        expect(row?.orgId).toBe(alice.orgId);
        expect(row?.kind).toBe('csv');
        expect(row?.authMode).toBe('upload');
        expect(Buffer.from(row?.credentials ?? []).length).toBe(0);
      });

      it('is idempotent — returns the existing account on repeat calls', async () => {
        const first = await app.inject({
          method: 'POST',
          url: '/connectors/csv/account',
          headers: { cookie: alice.cookie },
        });
        const second = await app.inject({
          method: 'POST',
          url: '/connectors/csv/account',
          headers: { cookie: alice.cookie },
        });

        const firstId = (first.json() as { id: string }).id;
        const secondId = (second.json() as { id: string }).id;
        expect(firstId).toBe(secondId);

        const count = await prisma.connectorAccount.count({
          where: { orgId: alice.orgId, kind: 'csv' },
        });
        expect(count).toBe(1);
      });

      it('scopes per-org — alice and bob each get a distinct account', async () => {
        const aliceRes = await app.inject({
          method: 'POST',
          url: '/connectors/csv/account',
          headers: { cookie: alice.cookie },
        });
        const bobRes = await app.inject({
          method: 'POST',
          url: '/connectors/csv/account',
          headers: { cookie: bob.cookie },
        });
        const aliceId = (aliceRes.json() as { id: string }).id;
        const bobId = (bobRes.json() as { id: string }).id;
        expect(aliceId).not.toBe(bobId);
      });

      it('returns 401 without a session cookie', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/connectors/csv/account',
        });
        expect(res.statusCode).toBe(401);
      });
    });
  },
);
