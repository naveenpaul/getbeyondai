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
import type { CsvSyncRunStatusResponse } from './csv-import.dto';

/**
 * Integration tests for the async CSV import HTTP layer (T8-CSV.2c.2).
 *
 * Boots the full Nest+Fastify app, registers @fastify/multipart, exercises
 * the full POST → enqueue → worker → poll round-trip.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024;

describe.skipIf(!DATABASE_URL)(
  'POST /connectors/csv/import (async integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let orgA: string;
    let orgB: string;
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
          contacts, sync_runs, connector_accounts,
          tool_calls, model_calls, citations, agent_runs,
          voices, company_brains, users, organizations
        RESTART IDENTITY CASCADE
      `);
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE pgboss.job, pgboss.archive RESTART IDENTITY`,
        )
        .catch(() => {
          // pg-boss schema not yet bootstrapped on the first beforeEach.
        });

      const o1 = await prisma.organization.create({ data: { name: 'OrgA' } });
      const o2 = await prisma.organization.create({ data: { name: 'OrgB' } });
      orgA = o1.id;
      orgB = o2.id;

      csvAccountA = (
        await prisma.connectorAccount.create({
          data: {
            orgId: orgA,
            kind: 'csv',
            authMode: 'upload',
            credentials: Buffer.from(''),
          },
        })
      ).id;
      hubspotAccountA = (
        await prisma.connectorAccount.create({
          data: {
            orgId: orgA,
            kind: 'hubspot',
            authMode: 'oauth',
            credentials: Buffer.from('test-sealed'),
          },
        })
      ).id;
      csvAccountB = (
        await prisma.connectorAccount.create({
          data: {
            orgId: orgB,
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
        headers: form.getHeaders(),
      });
    }

    async function pollSyncRunUntilDone(
      syncRunId: string,
      orgId: string,
    ): Promise<CsvSyncRunStatusResponse> {
      const start = Date.now();
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        const res = await app.inject({
          method: 'GET',
          url: `/connectors/csv/sync-runs/${syncRunId}?orgId=${orgId}`,
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
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
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

      const finalState = await pollSyncRunUntilDone(body.syncRunId, orgA);
      expect(finalState.status).toBe('completed');
      expect(finalState.recordsOut).toBe(2);
      expect(finalState.errorCount).toBe(0);

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
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
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('metadata');
    });

    it('400 when file field is missing', async () => {
      const form = new FormData();
      form.append(
        'metadata',
        JSON.stringify({
          orgId: orgA,
          sourceAccountId: csvAccountA,
          triggeredBy: 'usr_test',
          columnMapping: { email: 'Email' },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/connectors/csv/import',
        payload: form.getBuffer(),
        headers: form.getHeaders(),
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
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('valid JSON');
    });

    it('400 when metadata fails Zod validation (missing columnMapping.email)', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
        columnMapping: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('columnMapping.email');
    });

    it('404 when sourceAccountId does not exist', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        orgId: orgA,
        sourceAccountId: 'cuid_does_not_exist',
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('403 when ConnectorAccount belongs to a different org', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        orgId: orgA,
        sourceAccountId: csvAccountB,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 when ConnectorAccount kind is not csv', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        orgId: orgA,
        sourceAccountId: hubspotAccountA,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('hubspot');
    });

    it('413 when CSV exceeds the 5 MB inline cap', async () => {
      // Buffer larger than the multipart fileSize limit.
      const oversized = Buffer.alloc(MULTIPART_LIMIT_BYTES + 1024, 0x61); // 'a' bytes
      const res = await postMultipart(oversized, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(413);
    });

    // ─── GET /connectors/csv/sync-runs/:id ─────────────────────────────

    it('GET sync-runs/:id returns full status payload for a completed run', async () => {
      const postRes = await postMultipart('Email\nsarah@acme.com\ntom@beta.com', {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      const { syncRunId } = postRes.json() as { syncRunId: string };
      const final = await pollSyncRunUntilDone(syncRunId, orgA);

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
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      const { syncRunId } = postRes.json() as { syncRunId: string };
      const final = await pollSyncRunUntilDone(syncRunId, orgA);

      expect(final.status).toBe('completed');
      expect(final.recordsOut).toBe(2);
      expect(final.errorCount).toBeGreaterThanOrEqual(1);
      expect(final.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('GET sync-runs/:id returns 400 when orgId query param is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/csv/sync-runs/cuid_any',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('orgId');
    });

    it('GET sync-runs/:id returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/csv/sync-runs/cuid_does_not_exist?orgId=${orgA}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET sync-runs/:id returns 403 when orgId does not match the SyncRun owner', async () => {
      const postRes = await postMultipart('Email\nx@y.com', {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      const { syncRunId } = postRes.json() as { syncRunId: string };

      const res = await app.inject({
        method: 'GET',
        url: `/connectors/csv/sync-runs/${syncRunId}?orgId=${orgB}`,
      });
      expect(res.statusCode).toBe(403);
    });
  },
);
