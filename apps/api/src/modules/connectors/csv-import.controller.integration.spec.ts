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

/**
 * Integration tests for POST /connectors/csv/import (T8-CSV.2b).
 *
 * Boots the full Nest + Fastify app, registers @fastify/multipart, injects
 * multipart requests via Fastify's request-injection API. Shares the
 * test database with the other integration suites; same safety guard.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'POST /connectors/csv/import (integration)',
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
        limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 },
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
    });

    afterAll(async () => {
      // Defensive — if beforeAll bailed (e.g. plugin-version mismatch), `app`
      // and `prisma` may be undefined. Don't mask the real failure with a
      // teardown TypeError.
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
      csv: string,
      metadata: Record<string, unknown>,
    ) {
      const form = new FormData();
      form.append('file', Buffer.from(csv, 'utf8'), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
      form.append('metadata', JSON.stringify(metadata));
      return app.inject({
        method: 'POST',
        url: '/connectors/csv/import',
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
    }

    it('happy path: multipart upload → 200 + SyncRun in DB', async () => {
      const csv = [
        'Email,First Name,Company',
        'sarah@acme.com,Sarah,Acme',
        'tom@beta.com,Tom,Beta',
      ].join('\n');

      const res = await postMultipart(csv, {
        orgId: orgA,
        sourceAccountId: csvAccountA,
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email', firstName: 'First Name', company: 'Company' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        syncRunId: string;
        status: string;
        recordsIn: number;
        recordsOut: number;
      };
      expect(body.status).toBe('completed');
      expect(body.recordsIn).toBe(2);
      expect(body.recordsOut).toBe(2);

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
        columnMapping: {}, // missing required `email`
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
        orgId: orgA, // claiming OrgA
        sourceAccountId: csvAccountB, // but accountB is OrgB's
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 when ConnectorAccount kind is not csv', async () => {
      const res = await postMultipart('Email\nx@y.com', {
        orgId: orgA,
        sourceAccountId: hubspotAccountA, // HubSpot account, not CSV
        triggeredBy: 'usr_test',
        columnMapping: { email: 'Email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('hubspot');
    });
  },
);
