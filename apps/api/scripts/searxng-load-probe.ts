/**
 * SearXNG load probe (throwaway) — answers doc §10: does ONE SearXNG instance
 * survive the Researcher's query volume without upstream blocks?
 *
 * Drives the REAL SearxngSearchProvider against a running instance with a burst
 * of representative B2B research queries at configurable concurrency, and
 * reports success/empty/error rates + latency percentiles + a verdict.
 *
 * Start the instance first (the API rule: servers are user-managed):
 *   docker compose --profile searxng up -d searxng
 * Then:
 *   SEARXNG_URL=http://localhost:8080 PROBE_QUERIES=40 PROBE_CONCURRENCY=8 \
 *     node -r ts-node/register/transpile-only scripts/searxng-load-probe.ts
 */
import { SearxngSearchProvider } from '../src/modules/teammates/runtime/search/providers/searxng.provider';
import { SearchProviderError } from '../src/modules/teammates/runtime/search/search-provider';

/* eslint-disable no-console */

const BASE_URL = process.env.SEARXNG_URL ?? 'http://localhost:8080';
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? 8);
const TOTAL = Number(process.env.PROBE_QUERIES ?? 40);

/** Representative of what the Researcher fires while qualifying companies. */
const SEED_QUERIES: string[] = [
  'geosentry.ai bengaluru',
  'brightsparks software development bangalore',
  'maxon clouds company funding',
  'effihr HR tech startup',
  'voroth ai company',
  'Stripe fintech competitors',
  'Notion company funding rounds',
  'Ramp corporate card startup',
  'Vercel hosting company news',
  'Linear issue tracking startup',
  'Acme Corp seed funding 2025',
  'Razorpay payments India',
  'Zomato revenue employees',
  'Freshworks SaaS Chennai',
  'Postman API tool company',
  'Zerodha fintech Bangalore',
  'CRED company funding',
  'Meesho ecommerce startup',
  'Groww investing app India',
  'Cult.fit health startup',
];

interface Outcome {
  query: string;
  ms: number;
  ok: boolean;
  results: number;
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function timed(
  provider: SearxngSearchProvider,
  query: string,
): Promise<Outcome> {
  const start = Date.now();
  try {
    const out = await provider.search(query, { count: 10 });
    return { query, ms: Date.now() - start, ok: true, results: out.results.length };
  } catch (err) {
    const error =
      err instanceof SearchProviderError ? err.message : String(err);
    return { query, ms: Date.now() - start, ok: false, results: 0, error };
  }
}

async function main(): Promise<void> {
  console.log(
    `SearXNG load probe → ${BASE_URL}  (${TOTAL} queries, concurrency ${CONCURRENCY})\n`,
  );
  const provider = new SearxngSearchProvider({ baseUrl: BASE_URL });

  // Build the work list (cycle the seed queries up to TOTAL).
  const queries = Array.from({ length: TOTAL }, (_, i) => SEED_QUERIES[i % SEED_QUERIES.length]!);

  // Concurrency-limited pool.
  const outcomes: Outcome[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= queries.length) return;
      outcomes.push(await timed(provider, queries[i]!));
    }
  }
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queries.length) }, () => worker()),
  );
  const wallMs = Date.now() - started;

  const ok = outcomes.filter((o) => o.ok);
  const empty = ok.filter((o) => o.results === 0);
  const failed = outcomes.filter((o) => !o.ok);
  const latencies = ok.map((o) => o.ms).sort((a, b) => a - b);

  console.log('=== RESULTS ===');
  console.log(`ok:        ${ok.length}/${outcomes.length} (${pct(ok.length, outcomes.length)})`);
  console.log(`empty:     ${empty.length}/${ok.length} returned 0 results`);
  console.log(`failed:    ${failed.length}/${outcomes.length}`);
  console.log(`wall:      ${(wallMs / 1000).toFixed(1)}s  (~${(outcomes.length / (wallMs / 1000)).toFixed(1)} q/s)`);
  console.log(`latency:   p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${latencies[latencies.length - 1] ?? 0}ms`);

  if (failed.length) {
    console.log('\n=== ERROR BREAKDOWN ===');
    const byErr = new Map<string, number>();
    for (const f of failed) {
      const key = (f.error ?? 'unknown').slice(0, 80);
      byErr.set(key, (byErr.get(key) ?? 0) + 1);
    }
    for (const [err, n] of byErr) console.log(`  ${n}×  ${err}`);
  }

  const sample = ok.find((o) => o.results > 0);
  if (sample) console.log(`\nsample: "${sample.query}" → ${sample.results} results in ${sample.ms}ms`);

  console.log('\n=== VERDICT ===');
  const okRate = ok.length / outcomes.length;
  const emptyRate = ok.length ? empty.length / ok.length : 1;
  if (okRate >= 0.95 && emptyRate <= 0.2) {
    console.log('USABLE — instance held up under load with good recall.');
  } else if (okRate >= 0.8) {
    console.log('MARGINAL — some failures/empties; tune engines/timeouts or check upstream blocks.');
  } else {
    console.log('NOT USABLE — high failure rate; instance is being blocked/rate-limited or misconfigured.');
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '0%' : `${Math.round((100 * n) / d)}%`;
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('probe failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
