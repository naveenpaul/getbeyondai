/**
 * Per-run forensics for a prospect search's Researcher runs (throwaway).
 * Settles "fundamental vs edge case": did each run actually call tools
 * (brave_search/fetch_url) or did the model fail to drive the loop?
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/analyze-research-runs.ts <prospectSearchId>
 */
import { PrismaClient } from '@prisma/client';

/* eslint-disable no-console */
const ID = process.argv[2] ?? 'cmq0nijqr0001c3lgx2m0xtmo';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const runs = await prisma.agentRun.findMany({
      where: {
        inputContext: { path: ['prospectSearchId'], equals: ID },
        teammate: 'researcher',
      },
      orderBy: { startedAt: 'asc' },
      include: {
        modelCalls: { select: { modelName: true, provider: true, outputTokens: true, costCents: true } },
        toolCalls: { select: { toolName: true, durationMs: true } },
      },
    });

    console.log(`Researcher runs: ${runs.length}\n`);
    const toolHisto: Record<string, number> = {};
    let runsWithTools = 0;
    let runsWithModelCalls = 0;

    for (const r of runs) {
      const ctx = (r.inputContext as Record<string, unknown>) ?? {};
      const tools = r.toolCalls.map((t) => t.toolName);
      for (const t of tools) toolHisto[t] = (toolHisto[t] ?? 0) + 1;
      if (tools.length) runsWithTools++;
      if (r.modelCalls.length) runsWithModelCalls++;
      const models = [...new Set(r.modelCalls.map((m) => `${m.provider ?? '?'}/${m.modelName}`))];
      console.log(
        `• ${r.status.padEnd(10)} reason=${(r.reason ?? '-').slice(0, 26).padEnd(26)} ` +
          `modelCalls=${r.modelCalls.length} toolCalls=${tools.length} [${tools.join(',') || 'none'}] ` +
          `models=${models.join(',') || 'none'}  "${String(ctx['target'] ?? '').slice(0, 28)}"`,
      );
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`runs with >=1 model call: ${runsWithModelCalls}/${runs.length}`);
    console.log(`runs with >=1 tool call:  ${runsWithTools}/${runs.length}`);
    console.log(`tool-call histogram: ${JSON.stringify(toolHisto)}`);
    const allModels = [
      ...new Set(runs.flatMap((r) => r.modelCalls.map((m) => `${m.provider ?? '?'}/${m.modelName}`))),
    ];
    console.log(`research models seen: ${allModels.join(', ') || 'none'}`);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
