/**
 * SearXNG operator probe (throwaway) — do `site:`, `-exclude`, and `"exact"`
 * actually FILTER through SearXNG, or get stripped/ignored? Build the query
 * compiler against reality, not the docs (docs lied 3× this session).
 *
 *   docker compose --profile searxng up -d searxng
 *   SEARXNG_URL=http://localhost:8080 node -r ts-node/register/transpile-only \
 *     scripts/searxng-operator-probe.ts
 */
/* eslint-disable no-console */
const BASE = process.env.SEARXNG_URL ?? 'http://localhost:8080';

interface Row { url?: string; title?: string }

function domainOf(url: string | undefined): string {
  if (!url) return '?';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '?';
  }
}

async function search(q: string): Promise<Row[]> {
  const url = new URL(`${BASE}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { results?: Row[] };
  return body.results ?? [];
}

const CASES: Array<{ label: string; q: string; check: (rows: Row[]) => string }> = [
  {
    label: 'baseline',
    q: 'payroll software austin',
    check: (r) => `${r.length} results`,
  },
  {
    label: 'exact-match  "payroll software"',
    q: '"payroll software" austin',
    check: (r) => `${r.length} results`,
  },
  {
    label: 'site:linkedin.com (should restrict to linkedin)',
    q: 'payroll software austin site:linkedin.com',
    check: (r) => {
      const onLi = r.filter((x) => domainOf(x.url).includes('linkedin.com')).length;
      return `${onLi}/${r.length} on linkedin.com → ${onLi === r.length && r.length > 0 ? 'RESTRICTS ✓' : 'IGNORED ✗'}`;
    },
  },
  {
    label: 'site:github.com (open-source routing)',
    q: 'open source payroll site:github.com',
    check: (r) => {
      const onGh = r.filter((x) => domainOf(x.url).includes('github.com')).length;
      return `${onGh}/${r.length} on github.com → ${onGh === r.length && r.length > 0 ? 'RESTRICTS ✓' : 'IGNORED ✗'}`;
    },
  },
  {
    label: 'exclusion  -wikipedia -glassdoor',
    q: 'payroll software austin -wikipedia -glassdoor',
    check: (r) => {
      const banned = r.filter((x) => /wikipedia|glassdoor/.test(domainOf(x.url))).length;
      return `${banned} banned-domain hits → ${banned === 0 ? 'EXCLUDES ✓' : 'IGNORED ✗'}`;
    },
  },
  {
    label: 'full combo  "x" austin -agency site:linkedin.com',
    q: '"payroll software" austin -agency site:linkedin.com',
    check: (r) => {
      const onLi = r.filter((x) => domainOf(x.url).includes('linkedin.com')).length;
      return `${r.length} results, ${onLi} on linkedin`;
    },
  },
];

async function main(): Promise<void> {
  console.log(`SearXNG operator probe → ${BASE}\n`);
  for (const c of CASES) {
    try {
      const rows = await search(c.q);
      const domains = [...new Set(rows.slice(0, 6).map((r) => domainOf(r.url)))].join(', ');
      console.log(`• ${c.label}`);
      console.log(`    q: ${c.q}`);
      console.log(`    → ${c.check(rows)}`);
      console.log(`    top domains: ${domains || '(none)'}\n`);
    } catch (err) {
      console.log(`• ${c.label}: ERROR ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error('probe failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
