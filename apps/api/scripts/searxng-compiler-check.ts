/**
 * Live check: compile a real ICP → query and show what SearXNG returns, so we
 * can judge whether the compiled query yields company homepages (throwaway).
 *   SEARXNG_URL=http://localhost:8080 node -r ts-node/register/transpile-only \
 *     scripts/searxng-compiler-check.ts
 */
/* eslint-disable no-console */
import { compileSearxngQuery } from '../src/modules/connectors/sourcing/searxng-query';
import type { IcpCriteria } from '../src/modules/connectors/sourcing/sourcing-provider';

const BASE = process.env.SEARXNG_URL ?? 'http://localhost:8080';

// "find me cool small software startups in Austin that aren't agencies"
const ICP: IcpCriteria = {
  keywords: ['startup'],
  employeeCountMin: null,
  employeeCountMax: 50,
  fundingStages: ['seed'],
  industries: ['software'],
  locations: ['Austin'],
};

function domainOf(u: string | undefined): string {
  try {
    return new URL(u ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '?';
  }
}

async function main(): Promise<void> {
  const q = compileSearxngQuery(ICP, { negativeKeywords: ['agency', 'consulting'] });
  console.log(`compiled query:\n  ${q}\n`);
  const url = new URL(`${BASE}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  const body = (await res.json()) as { results?: Array<{ url?: string; title?: string }> };
  const rows = body.results ?? [];
  console.log(`${rows.length} results. Domains:`);
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${domainOf(r.url).padEnd(28)} ${String(r.title ?? '').slice(0, 50)}`);
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error('failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
