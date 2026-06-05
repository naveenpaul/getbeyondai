/**
 * Dump emit_draft tool-call args + results for the abstained Researcher runs of
 * a prospect search — to see WHY drafts were rejected (throwaway).
 *   node --env-file=.env -r ts-node/register/transpile-only \
 *     scripts/inspect-emit-draft.ts <prospectSearchId>
 */
import { PrismaClient } from '@prisma/client';

/* eslint-disable no-console */
const ID = process.argv[2] ?? 'cmq0nijqr0001c3lgx2m0xtmo';

function trunc(v: unknown, n: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const runs = await prisma.agentRun.findMany({
      where: {
        inputContext: { path: ['prospectSearchId'], equals: ID },
        teammate: 'researcher',
        reason: 'no_draft_emitted',
      },
      orderBy: { startedAt: 'asc' },
      take: 2,
      include: {
        toolCalls: {
          where: { toolName: 'emit_draft' },
          orderBy: { toolSeq: 'asc' },
        },
      },
    });

    for (const r of runs) {
      const ctx = (r.inputContext as Record<string, unknown>) ?? {};
      console.log(`\n###### ${String(ctx['target'])}  (${r.toolCalls.length} emit_draft attempts) ######`);
      for (const tc of r.toolCalls.slice(0, 3)) {
        console.log(`\n-- attempt seq=${tc.toolSeq} --`);
        console.log(`ARGS:   ${trunc(tc.args, 700)}`);
        console.log(`RESULT: ${trunc(tc.result, 500)}`);
      }
    }
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
