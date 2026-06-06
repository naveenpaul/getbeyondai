import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { QueueService } from '../queue/queue.service';
import {
  DRAFT_ACTION_QUEUE,
  DraftActionWorker,
  type DraftActionJobPayload,
} from './draft-action.worker';
import { CURRENT_PAYLOAD_SCHEMA_VERSION } from './draft-action.schemas';

const DATABASE_URL = process.env.DATABASE_URL;
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

async function waitForActionTerminal(
  prisma: PrismaClient,
  draftActionId: string,
): Promise<{ status: string; responsePayload: unknown }> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const a = await prisma.draftAction.findUnique({
      where: { id: draftActionId },
    });
    if (
      a &&
      (a.status === 'succeeded' ||
        a.status === 'failed' ||
        a.status === 'dead_lettered')
    ) {
      return { status: a.status, responsePayload: a.responsePayload };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `DraftAction ${draftActionId} did not terminate in ${POLL_TIMEOUT_MS}ms`,
  );
}

describe.skipIf(!DATABASE_URL)(
  'DraftActionWorker (integration — needs live Postgres + pg-boss schema)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let queue: QueueService;
    let worker: DraftActionWorker;
    let orgA: string;
    let draftId: string;
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
      worker = app.get(DraftActionWorker);

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
        .catch(() => {});

      const o = await prisma.organization.create({ data: { name: 'OrgA' } });
      orgA = o.id;
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

      // Every test needs a Draft. The shape doesn't matter for these tests —
      // it's just the row a DraftAction can FK to.
      const draft = await prisma.draft.create({
        data: {
          orgId: orgA,
          teammate: 'sdr-drafter',
          type: 'email',
          content: { subject: 'Test', body: 'Test' },
          status: 'approved',
        },
      });
      draftId = draft.id;
    });

    // ─── Happy paths ───────────────────────────────────────────────────

    it('echo destination → action succeeds with echoed payload', async () => {
      const action = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: {
            to: 'sarah@acme.com',
            subject: 'Quick question',
            body: 'Hey Sarah — got a minute?',
          },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}`,
        },
      });

      await queue.send<DraftActionJobPayload>(DRAFT_ACTION_QUEUE, {
        draftActionId: action.id,
      });
      const final = await waitForActionTerminal(prisma, action.id);
      expect(final.status).toBe('succeeded');
      expect(final.responsePayload).toMatchObject({
        echoed: { to: 'sarah@acme.com' },
      });
    });

    it('archive destination → action succeeds AND parent Draft status → rejected', async () => {
      const action = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'archive',
          payload: {},
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}`,
        },
      });

      await worker.processOnce(action.id);

      const draft = await prisma.draft.findUnique({ where: { id: draftId } });
      expect(draft?.status).toBe('rejected');

      const reloadedAction = await prisma.draftAction.findUnique({
        where: { id: action.id },
      });
      expect(reloadedAction?.status).toBe('succeeded');
    });

    // ─── Failure paths ─────────────────────────────────────────────────

    it('payload fails Zod validation → status=failed, no vendor call', async () => {
      const action = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: { to: 'not-an-email', subject: 'X', body: 'Y' }, // bad email
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}`,
        },
      });

      await worker.processOnce(action.id);

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: action.id },
      });
      expect(reloaded?.status).toBe('failed');
      expect(reloaded?.responsePayload).toMatchObject({
        reason: 'payload_validation_failed',
      });
    });

    it('mismatched payloadSchemaVersion → status=failed', async () => {
      const action = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: { to: 'sarah@acme.com', subject: 'X', body: 'Y' },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION + 99, // future schema
          idempotencyKey: `idem-${Date.now()}`,
        },
      });

      await worker.processOnce(action.id);

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: action.id },
      });
      expect(reloaded?.status).toBe('failed');
      expect(reloaded?.responsePayload).toMatchObject({
        reason: 'payload_schema_version_mismatch',
      });
    });

    it('echo destination returns failed when idempotencyKey carries the test-fail sentinel → status=failed', async () => {
      const action = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'crm_log_activity',
          payload: {
            contactId: 'cont_abc',
            type: 'note',
            summary: 's',
          },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          // Echo destination's test-fail sentinel lives on idempotencyKey
          // (not the payload) so we don't need to weaken Zod's stripping.
          idempotencyKey: `test-fail:${Date.now()}`,
        },
      });

      await worker.processOnce(action.id);

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: action.id },
      });
      expect(reloaded?.status).toBe('failed');
      expect(reloaded?.responsePayload).toMatchObject({
        reason: 'adapter_returned_failed',
      });
    });

    // ─── Idempotency ──────────────────────────────────────────────────

    it('replay (already-terminal action) is a no-op', async () => {
      const action = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: { to: 'sarah@acme.com', subject: 'X', body: 'Y' },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}`,
          status: 'succeeded', // pretend the first run already won
          attempts: 1,
        },
      });

      await worker.processOnce(action.id);

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: action.id },
      });
      // attempts should NOT have incremented — the worker bailed early.
      expect(reloaded?.attempts).toBe(1);
      expect(reloaded?.status).toBe('succeeded');
    });

    it('non-existent action id → silently completes (no throw)', async () => {
      await expect(
        worker.processOnce('cuid_does_not_exist'),
      ).resolves.not.toThrow();
    });
  },
);
