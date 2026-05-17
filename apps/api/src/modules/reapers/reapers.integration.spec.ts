import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { SyncRunReaper } from './sync-run.reaper';
import { DraftActionReaper } from './draft-action.reaper';
import { CURRENT_PAYLOAD_SCHEMA_VERSION } from '../drafts/draft-action.schemas';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'Stale-running reapers (integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let syncRunReaper: SyncRunReaper;
    let draftActionReaper: DraftActionReaper;
    let orgA: string;
    let csvAccountA: string;
    let draftId: string;

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
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      syncRunReaper = app.get(SyncRunReaper);
      draftActionReaper = app.get(DraftActionReaper);

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
      draftId = (
        await prisma.draft.create({
          data: {
            orgId: orgA,
            teammate: 'sdr-drafter',
            type: 'email',
            content: { subject: 'T', body: 'T' },
            status: 'approved',
          },
        })
      ).id;
    });

    // ─── SyncRunReaper ─────────────────────────────────────────────────

    it('SyncRunReaper marks stale running SyncRuns as failed', async () => {
      // Create a SyncRun that "started" 30 min ago — well past the 15 min default.
      const oldStartedAt = new Date(Date.now() - 30 * 60 * 1000);
      const stale = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'running',
          startedAt: oldStartedAt,
        },
      });

      const reaped = await syncRunReaper.reap();
      expect(reaped).toBeGreaterThanOrEqual(1);

      const reloaded = await prisma.syncRun.findUnique({
        where: { id: stale.id },
      });
      expect(reloaded?.status).toBe('failed');
      expect(reloaded?.completedAt).toBeTruthy();
      expect(reloaded?.errorCount).toBe(1);

      const errors = reloaded?.errors as Array<{ reason: string }>;
      expect(errors[0]?.reason).toBe('stale_run');
    });

    it('SyncRunReaper leaves fresh running SyncRuns alone', async () => {
      const fresh = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'running',
          // Started just now — under the 15 min threshold.
        },
      });

      await syncRunReaper.reap();

      const reloaded = await prisma.syncRun.findUnique({
        where: { id: fresh.id },
      });
      expect(reloaded?.status).toBe('running');
    });

    it('SyncRunReaper does not touch already-terminal rows', async () => {
      const completed = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'completed',
          startedAt: new Date(Date.now() - 60 * 60 * 1000), // old but already done
          completedAt: new Date(Date.now() - 50 * 60 * 1000),
          recordsOut: 100,
        },
      });

      await syncRunReaper.reap();

      const reloaded = await prisma.syncRun.findUnique({
        where: { id: completed.id },
      });
      expect(reloaded?.status).toBe('completed');
      expect(reloaded?.recordsOut).toBe(100);
    });

    it('SyncRunReaper accepts an injected staleMs for fast tests', async () => {
      const justOverThreshold = await prisma.syncRun.create({
        data: {
          orgId: orgA,
          connectorAccountId: csvAccountA,
          direction: 'pull',
          status: 'running',
          startedAt: new Date(Date.now() - 200), // 200 ms ago
        },
      });

      // 100 ms threshold — the row above is over it.
      const reaped = await syncRunReaper.reap(new Date(), 100);
      expect(reaped).toBeGreaterThanOrEqual(1);

      const reloaded = await prisma.syncRun.findUnique({
        where: { id: justOverThreshold.id },
      });
      expect(reloaded?.status).toBe('failed');
    });

    // ─── DraftActionReaper ─────────────────────────────────────────────

    it('DraftActionReaper marks stale running DraftActions as failed', async () => {
      const oldUpdatedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const stale = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: { to: 'a@b.com', subject: 'X', body: 'Y' },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}`,
          status: 'running',
        },
      });
      // Backdate updatedAt via raw SQL — Prisma's `@updatedAt` overrides any
      // value we'd pass through `update`.
      await prisma.$executeRawUnsafe(
        `UPDATE draft_actions SET "updatedAt" = $1::timestamp WHERE id = $2`,
        oldUpdatedAt.toISOString(),
        stale.id,
      );

      const reaped = await draftActionReaper.reap();
      expect(reaped).toBeGreaterThanOrEqual(1);

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: stale.id },
      });
      expect(reloaded?.status).toBe('failed');
      expect(
        (reloaded?.responsePayload as { reason?: string })?.reason,
      ).toBe('stale_run');
      expect(reloaded?.executedAt).toBeTruthy();
    });

    it('DraftActionReaper leaves fresh running DraftActions alone', async () => {
      const fresh = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: { to: 'a@b.com', subject: 'X', body: 'Y' },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}-fresh`,
          status: 'running',
        },
      });

      await draftActionReaper.reap();

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: fresh.id },
      });
      expect(reloaded?.status).toBe('running');
    });

    it('DraftActionReaper does not touch terminal rows', async () => {
      const succeeded = await prisma.draftAction.create({
        data: {
          draftId,
          kind: 'send_email',
          payload: { to: 'a@b.com', subject: 'X', body: 'Y' },
          payloadSchemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
          idempotencyKey: `idem-${Date.now()}-done`,
          status: 'succeeded',
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE draft_actions SET "updatedAt" = $1::timestamp WHERE id = $2`,
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        succeeded.id,
      );

      await draftActionReaper.reap();

      const reloaded = await prisma.draftAction.findUnique({
        where: { id: succeeded.id },
      });
      expect(reloaded?.status).toBe('succeeded');
    });
  },
);
