/**
 * Analyze a prospect search end-to-end from the DB (throwaway diagnostic).
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/analyze-prospect-search.ts <prospectSearchId>
 */
import { PrismaClient } from '@prisma/client';

/* eslint-disable no-console */
const ID = process.argv[2] ?? 'cmq0nijqr0001c3lgx2m0xtmo';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const ps = await prisma.prospectSearch.findUnique({ where: { id: ID } });
    if (!ps) {
      console.log(`No ProspectSearch ${ID}`);
      return;
    }
    console.log('=== SEARCH ===');
    console.log(`title:   ${ps.title}`);
    console.log(`goal:    ${ps.goal}`);
    console.log(`status:  ${ps.status}`);
    console.log(`sourcing: ${JSON.stringify(ps.sourcing)}`);
    console.log(`budgetCents: ${ps.budgetCents ?? '(default)'}`);
    console.log(`icpCriteria (user overrides): ${JSON.stringify(ps.icpCriteria)}`);
    console.log(`winsListId: ${ps.winsListId ?? '(none)'}`);
    console.log(`createdAt: ${ps.createdAt.toISOString()}`);

    const runs = await prisma.agentRun.findMany({
      where: { inputContext: { path: ['prospectSearchId'], equals: ID } },
      orderBy: { startedAt: 'asc' },
    });
    console.log(`\n=== AGENT RUNS (${runs.length}) ===`);
    let totalCost = 0;
    for (const r of runs) {
      const ctx = (r.inputContext as Record<string, unknown>) ?? {};
      totalCost += r.costCents ?? 0;
      console.log(
        `• ${r.teammate}  phase=${String(ctx['phase'] ?? '?')}  status=${r.status}  ` +
          `cost=${r.costCents ?? 0}¢  ${ctx['target'] ? `target="${String(ctx['target'])}"` : ''}`,
      );
      if (ctx['icp']) console.log(`    derived ICP: ${JSON.stringify(ctx['icp'])}`);
    }
    console.log(`total agent-run cost: ${totalCost}¢`);

    const prospects = await prisma.prospect.findMany({
      where: { prospectSearchId: ID },
      orderBy: { fitScore: 'desc' },
    });
    console.log(`\n=== PROSPECTS (${prospects.length}) ===`);
    for (const p of prospects) {
      console.log(
        `• ${p.fitScore.toFixed(2)}  ${p.name}  [${p.domain ?? 'no domain'}]  ${p.draftId ? '(brief)' : '(no brief)'}`,
      );
      console.log(`    ${p.rationale.slice(0, 160)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('analyze failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
