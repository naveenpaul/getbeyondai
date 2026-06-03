import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  InvalidSignalObservationError,
  listCompanySignals,
  upsertCompanySignal,
} from './company-signal.repository';

/**
 * Integration tests for the CompanySignal repository.
 *
 * Required setup before running (mirrors contact-upsert.integration.spec.ts):
 *   1. `docker compose up -d postgres` (from `getbeyond/`)
 *   2. `psql ... -c "CREATE DATABASE getbeyond_test"`
 *   3. Apply migrations to the test DB:
 *        `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *         pnpm --filter '@getbeyond/api' prisma:migrate`
 *   4. Run integration tests:
 *        `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *         pnpm --filter '@getbeyond/api' test:integration`
 *
 * Safety: TRUNCATEs company_signals / prospects / prospect_searches /
 * organizations before each test. Refuses to run unless the DB name contains
 * 'test'.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'CompanySignal repository (integration — needs live Postgres + applied migrations)',
  () => {
    let prisma: PrismaClient;
    let prospectId: string;

    beforeAll(() => {
      const dbName = (DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
      if (!dbName.includes('test')) {
        throw new Error(
          `Refusing to run: DATABASE_URL db "${dbName}" does not contain 'test'. ` +
            `Tests TRUNCATE signal/prospect/org tables on each run.`,
        );
      }
      prisma = new PrismaClient();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "company_signals", "prospects", "prospect_searches", "organizations" RESTART IDENTITY CASCADE`,
      );
      const org = await prisma.organization.create({ data: { name: 'OrgA' } });
      const prospectSearch = await prisma.prospectSearch.create({
        data: {
          orgId: org.id,
          title: 'Q3 prospects',
          goal: 'find devtool buyers',
          createdBy: 'user-1',
        },
      });
      const prospect = await prisma.prospect.create({
        data: {
          prospectSearchId: prospectSearch.id,
          name: 'Acme',
          domain: 'acme.com',
          fitScore: 0.8,
          rationale: 'matches ICP',
        },
      });
      prospectId = prospect.id;
    });

    it('creates a signal observation', async () => {
      const signal = await upsertCompanySignal(prisma, {
        prospectId,
        key: 'recently_funded',
        status: 'present',
        source: 'connector',
        value: { amount: 20_000_000, round: 'B' },
        detectedAt: new Date('2026-05-01T00:00:00Z'),
      });
      expect(signal.key).toBe('recently_funded');
      expect(signal.status).toBe('present');
      expect(signal.value).toEqual({ amount: 20_000_000, round: 'B' });
      expect(signal.detectedAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    });

    it('upsert is idempotent on (prospectId, key) — re-eval UPDATES, no duplicate', async () => {
      await upsertCompanySignal(prisma, {
        prospectId,
        key: 'hiring_for_role',
        status: 'unknown',
        source: 'research',
      });
      const updated = await upsertCompanySignal(prisma, {
        prospectId,
        key: 'hiring_for_role',
        status: 'present',
        source: 'research',
        citationId: 'cit-x',
        detectedAt: new Date('2026-06-01T00:00:00Z'),
      });

      const all = await listCompanySignals(prisma, prospectId);
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(updated.id);
      expect(all[0]?.status).toBe('present');
      expect(all[0]?.citationId).toBe('cit-x');
    });

    it('rejects a present research signal with no citation (cite-or-abstain) before writing', async () => {
      await expect(
        upsertCompanySignal(prisma, {
          prospectId,
          key: 'has_problem',
          status: 'present',
          source: 'research',
        }),
      ).rejects.toThrow(InvalidSignalObservationError);
      expect(await listCompanySignals(prisma, prospectId)).toHaveLength(0);
    });

    it('rejects an unregistered signal key before writing', async () => {
      await expect(
        upsertCompanySignal(prisma, {
          prospectId,
          key: 'totally_made_up',
          status: 'present',
          source: 'connector',
        }),
      ).rejects.toThrow(InvalidSignalObservationError);
    });

    it('lists multiple signals for a candidate', async () => {
      await upsertCompanySignal(prisma, {
        prospectId,
        key: 'has_problem',
        status: 'present',
        source: 'research',
        citationId: 'c1',
      });
      await upsertCompanySignal(prisma, {
        prospectId,
        key: 'reachable_decision_maker',
        status: 'present',
        source: 'computed',
      });
      const all = await listCompanySignals(prisma, prospectId);
      expect(all.map((s) => s.key).sort()).toEqual([
        'has_problem',
        'reachable_decision_maker',
      ]);
    });

    it('cascades: deleting the candidate removes its signals', async () => {
      await upsertCompanySignal(prisma, {
        prospectId,
        key: 'has_problem',
        status: 'present',
        source: 'research',
        citationId: 'c1',
      });
      await prisma.prospect.delete({ where: { id: prospectId } });
      const orphans = await prisma.companySignal.findMany({
        where: { prospectId },
      });
      expect(orphans).toHaveLength(0);
    });
  },
);
