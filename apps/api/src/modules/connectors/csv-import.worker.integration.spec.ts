import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { QueueService } from '../queue/queue.service';
import { CSV_IMPORT_QUEUE, type CsvImportJobPayload } from './csv-import.worker';

/**
 * Integration tests for CsvImportWorker (T8-CSV.2c.1).
 *
 * Boots the full Nest app so pg-boss starts via QueueService.onModuleInit
 * and CsvImportWorker registers itself. Tests enqueue a job through
 * QueueService directly (no HTTP layer) and poll the SyncRun row until the
 * worker drives it to a terminal status.
 *
 * Required setup: same as the other integration suites + the test database
 * must be reachable for pg-boss to bootstrap its `pgboss` schema. The first
 * run takes ~1s longer while pg-boss creates its tables.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

async function waitForSyncRun(
  prisma: PrismaClient,
  syncRunId: string,
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: string; recordsOut: number; errorCount: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await prisma.syncRun.findUnique({ where: { id: syncRunId } });
    if (run && (run.status === 'completed' || run.status === 'failed')) {
      return {
        status: run.status,
        recordsOut: run.recordsOut,
        errorCount: run.errorCount,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `SyncRun ${syncRunId} did not reach a terminal status in ${timeoutMs}ms`,
  );
}

describe.skipIf(!DATABASE_URL)(
  'CsvImportWorker (integration — needs live Postgres + pg-boss schema)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let queue: QueueService;
    let orgA: string;
    let csvAccountA: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}".`,
        );
      }
      process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
      process.env.SEARXNG_URL ||= 'http://searxng.test';
      process.env.CREDENTIAL_MASTER_KEY ||= Buffer.from(
        new Uint8Array(32).fill(7),
      ).toString('base64');
      process.env.AUTH_SECRET ||= 'test-auth-secret-32-chars-padding-to-match';

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      queue = app.get(QueueService);

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
      // Clear app tables. Then clear pg-boss queues so a failed job from a
      // prior test doesn't bleed into this one.
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
          // pg-boss schema may not exist yet on the very first beforeEach.
          // The next start() creates it; subsequent beforeEach calls succeed.
        });

      const o = await prisma.organization.create({ data: { name: 'OrgA' } });
      orgA = o.id;
      const a = await prisma.connectorAccount.create({
        data: {
          orgId: orgA,
          kind: 'csv',
          authMode: 'upload',
          credentials: Buffer.from(''),
        },
      });
      csvAccountA = a.id;
    });

    it('happy path: enqueued job → worker drives SyncRun to completed + Contacts in DB', async () => {
      const syncRun = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'running',
        },
      });

      const csv = ['Email,First Name', 'sarah@acme.com,Sarah', 'tom@beta.com,Tom'].join(
        '\n',
      );

      const jobId = await queue.send<CsvImportJobPayload>(CSV_IMPORT_QUEUE, {
        syncRunId: syncRun.id,
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'inline', base64: Buffer.from(csv, 'utf8').toString('base64') },
        columnMapping: { email: 'Email', firstName: 'First Name' },
        triggeredBy: 'usr_test',
      });
      expect(jobId).toBeTruthy();

      const result = await waitForSyncRun(prisma, syncRun.id);
      expect(result.status).toBe('completed');
      expect(result.recordsOut).toBe(2);
      expect(result.errorCount).toBe(0);

      const contacts = await prisma.contact.findMany({ where: { orgId: orgA } });
      expect(contacts).toHaveLength(2);
      const emails = contacts.map((c) => c.normalizedEmail).sort();
      expect(emails).toEqual(['sarah@acme.com', 'tom@beta.com']);
    });

    it('mixed valid/invalid rows: worker still completes, errors[] populated', async () => {
      const syncRun = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'running',
        },
      });

      const csv = [
        'Email',
        'sarah@acme.com',
        '',
        'malformed',
        'tom@beta.com',
      ].join('\n');

      await queue.send<CsvImportJobPayload>(CSV_IMPORT_QUEUE, {
        syncRunId: syncRun.id,
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'inline', base64: Buffer.from(csv, 'utf8').toString('base64') },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      const result = await waitForSyncRun(prisma, syncRun.id);
      expect(result.status).toBe('completed');
      expect(result.recordsOut).toBe(2);
      expect(result.errorCount).toBeGreaterThanOrEqual(1);
    });

    it('worker reuses the producer-created SyncRun (does not create a second one)', async () => {
      const syncRun = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'running',
        },
      });

      const csv = 'Email\nsarah@acme.com\n';

      await queue.send<CsvImportJobPayload>(CSV_IMPORT_QUEUE, {
        syncRunId: syncRun.id,
        orgId: orgA,
        sourceAccountId: csvAccountA,
        csv: { kind: 'inline', base64: Buffer.from(csv, 'utf8').toString('base64') },
        columnMapping: { email: 'Email' },
        triggeredBy: 'usr_test',
      });

      await waitForSyncRun(prisma, syncRun.id);

      const runs = await prisma.syncRun.findMany({ where: { orgId: orgA } });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.id).toBe(syncRun.id);
    });
  },
);
