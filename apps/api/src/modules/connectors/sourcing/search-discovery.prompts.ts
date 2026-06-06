import type { IcpCriteria } from './sourcing-provider';

/**
 * Search-discovery prompts + pure parsers (Phase B).
 *
 * Two `callModel` steps drive search-as-discovery, both STRICT-JSON (not agent
 * loops), mirroring the ICP/scoring prompts in `prospect-search.prompts.ts`:
 *   1. QUERY BUILD — ICP + intent + win exemplars → ≤3 distinct-angle web queries.
 *   2. NORMALIZE   — raw search hits → candidate companies (drops funds/ecosystem
 *                    noise), with whatever funding/date signal the snippet carried.
 *
 * The prompt strings live in source for the trust positioning (auditable/forkable).
 * The PARSERS here are pure + total: a malformed model turn degrades to "fewer
 * queries" / "fewer candidates", never a throw — so the discovery provider's
 * LLM edges are fully unit-testable without a live model.
 *
 * Caps (review #3 — no searxng query explosion / prompt bloat):
 *   - ≤ MAX_EXEMPLARS win companies fed to the query builder (not all 50).
 *   - ≤ MAX_DISCOVERY_QUERIES search vectors emitted per run.
 */

/** Max win companies used as lookalike exemplars in the query prompt. */
export const MAX_EXEMPLARS = 5;
/** Max search vectors emitted per discovery run. */
export const MAX_DISCOVERY_QUERIES = 5;
/**
 * Cap on companies the normalize step may emit. Bounds output tokens so the
 * STRICT-JSON response can't be truncated mid-array (which would fail the parse
 * and yield ZERO companies) when a mined list page names dozens of startups.
 * Pair with the discovery token ceiling in the worker.
 */
export const MAX_NORMALIZE_COMPANIES = 30;

export type DiscoveryCategory = 'news' | 'general';

/** One search vector the builder emits. */
export interface DiscoveryQuery {
  q: string;
  category: DiscoveryCategory;
  /** Short label of the angle this query covers (for logging/telemetry). */
  angle: string;
}

/** One company extracted from search results, pre-enrichment (domain may be null). */
export interface RawDiscoveredCompany {
  name: string;
  domain: string | null;
  /** e.g. "seed", "series_a" — null when the snippet didn't say. */
  fundingStage: string | null;
  /** Funding amount in USD when stated, else null. */
  amountUsd: number | null;
  /** ISO-ish announced date when stated, else null (used by D2 recency filter). */
  announcedDate: string | null;
  /** The result URL the company was extracted from (provenance for the Researcher). */
  sourceUrl: string | null;
}

/**
 * Pick at most `max` lookalike exemplars from the wins company names. Pure +
 * order-preserving (the caller hands them fit-ranked / sampled; early on this is
 * a simple cap, after Phase C the caller passes variance-chosen archetypes).
 * Dedupes case-insensitively and drops blanks.
 */
export function selectExemplars(
  companies: readonly string[],
  max: number = MAX_EXEMPLARS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of companies) {
    const trimmed = (c ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

export const DISCOVERY_QUERY_BUILDER_SYSTEM_PROMPT = `You turn an ICP into web-search queries that DISCOVER companies similar to a set of example customers — companies the user does NOT already have.

Output 1–${MAX_DISCOVERY_QUERIES} search queries, each targeting a DISTINCT angle (e.g. industry+geo, a buying-signal/news angle, a lookalike-by-segment angle). Do not emit near-duplicate queries.

Rules:
- Portable across general search engines: plain keywords. No engine-specific operators (no site:, no heavy boolean, no quotes unless a multi-word proper noun).
- Find SIMILAR companies, never the example companies themselves — do NOT put an example company's name in a query as the target.
- Bake any recency window into words ("raised funding 2026", "last 3 months", "recently"), never rely on a date filter.
- Prefer phrasings that surface LISTS or NEWS of many companies, not one company's homepage.
- Tie each query to the ICP's intent and the declared signal questions.

Return STRICT JSON, no prose:
{"queries":[{"q":"<string>","category":"news"|"general","angle":"<short label>"}]}
Maximum ${MAX_DISCOVERY_QUERIES} items.`;

/** Build the query-builder user turn from the ICP + intent + exemplars + signals. */
export function buildDiscoveryQueryUserPrompt(
  icp: IcpCriteria,
  intent: string,
  exemplars: readonly string[],
  signalQuestions: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(`ICP industries: ${fmtList(icp.industries)}`);
  lines.push(`ICP locations: ${fmtList(icp.locations)}`);
  lines.push(`ICP keywords: ${fmtList(icp.keywords)}`);
  lines.push(`Headcount: ${icp.employeeCountMin ?? '—'} to ${icp.employeeCountMax ?? '—'}`);
  lines.push(`What the user is looking for (intent): ${intent.trim() || '(none stated)'}`);
  lines.push(
    `Example customers to find LOOKALIKES of (positive examples, NOT targets): ${fmtList(exemplars)}`,
  );
  lines.push(
    `Buying-signal questions to weave in: ${fmtList(signalQuestions)}`,
  );
  lines.push('');
  lines.push(
    `Produce up to ${MAX_DISCOVERY_QUERIES} distinct-angle search queries per the rules.`,
  );
  return lines.join('\n');
}

/**
 * Parse the query-builder's STRICT-JSON output → validated `DiscoveryQuery[]`,
 * capped to MAX_DISCOVERY_QUERIES. Tolerates a markdown fence and a bare array.
 * Drops items without a non-empty `q`; defaults a missing/invalid `category` to
 * 'general' and a missing `angle` to ''. Never throws.
 */
export function parseDiscoveryQueries(text: string): DiscoveryQuery[] {
  const arr = asItemArray(text, 'queries');
  const out: DiscoveryQuery[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const q = asNonEmptyString(obj['q']);
    if (!q) continue;
    const category: DiscoveryCategory =
      obj['category'] === 'news' ? 'news' : 'general';
    const angle = asNonEmptyString(obj['angle']) ?? '';
    out.push({ q, category, angle });
    if (out.length >= MAX_DISCOVERY_QUERIES) break;
  }
  return out;
}

export const DISCOVERY_NORMALIZE_SYSTEM_PROMPT = `You extract operating COMPANIES that match the search intent from web/news search results AND from the full text of fetched LIST/roundup pages.

You are given two kinds of input:
- SEARCH RESULTS: a title + snippet per hit. A single-company hit yields one company.
- LIST PAGES: the fetched body of a "top N startups" / roundup / league-table page. These ENUMERATE many companies — extract EVERY operating company named in the list, not just the page's own brand.

Rules:
- Output operating COMPANIES only. DROP venture funds, accelerators, "fund I/II/III" raises, the publisher/aggregator running the list (e.g. the directory site itself), and anything that is not a company that could be a customer.
- A list/roundup is a SOURCE OF COMPANIES, not noise — mine it. (Older guidance dropped roundups; do the opposite now: harvest the companies inside them.)
- Do not invent companies not present in the input. If a result or page names no clear company, skip it.
- Pull a company's own website domain only when the text states it; otherwise leave domain null (it will be resolved later). A result/page URL is the source, NOT the company domain.
- Capture funding stage, USD amount, and announced date ONLY when stated; else null.
- Return at most ${MAX_NORMALIZE_COMPANIES} companies (the strongest matches first). Deduplicate by company.

Return STRICT JSON, no prose:
{"companies":[{"name":"<string>","domain":"<string|null>","fundingStage":"<string|null>","amountUsd":<number|null>,"announcedDate":"<string|null>","sourceUrl":"<source url|null>"}]}`;

/** A fetched list/roundup page whose body we mine for the companies it names. */
export interface DiscoveryListPage {
  url: string;
  title: string;
  /** Cleaned page text (already truncated by the caller). */
  text: string;
}

/**
 * Heuristic: does this search hit look like a LIST/roundup of many companies
 * (worth fetching + mining) rather than a single company's page? Pure + total.
 * Used only to decide WHAT to fetch — the LLM still does the extraction, so a
 * false positive just fetches a normal page (≤1 company) and a false negative
 * just misses a list; neither corrupts output.
 */
export function isListShaped(hit: { title: string; description: string }): boolean {
  const text = `${hit.title} ${hit.description}`.toLowerCase();
  // Must name companies in the plural AND carry a "this is a list" cue. Either
  // alone is too loose (a single-company page says "companies" generically; a
  // number alone matches funding amounts). Both together is a strong roundup
  // signal. False positives are cheap (we just fetch an extra page).
  const namesMany = /\b(startups|companies|firms|brands)\b/.test(text);
  const listCue =
    /\b(top|best|leading|notable|promising)\b/.test(text) ||
    /\blist of\b/.test(text) ||
    /\b\d{2,}\+?\b/.test(text) || // "29", "505+", a year like "2026"
    /\bto watch\b/.test(text) ||
    /\bfastest[- ]growing\b/.test(text) ||
    /\b(roundup|league table|directory)\b/.test(text);
  return namesMany && listCue;
}

/**
 * Build the normalize user turn from raw search hits (title/url/snippet/age)
 * plus any fetched LIST pages whose body we mine for the companies they name.
 */
export function buildNormalizeUserPrompt(
  results: ReadonlyArray<{
    title: string;
    url: string;
    description: string;
    age: string | null;
  }>,
  listPages: ReadonlyArray<DiscoveryListPage> = [],
): string {
  const blocks = results.map((r, i) =>
    [
      `[${i + 1}] ${r.title}`,
      `url: ${r.url}`,
      r.age ? `date: ${r.age}` : null,
      `snippet: ${r.description}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const sections = [`Search results:\n\n${blocks.join('\n\n')}`];
  if (listPages.length > 0) {
    const pageBlocks = listPages.map((p, i) =>
      [`[LIST ${i + 1}] ${p.title}`, `url: ${p.url}`, `page text:`, p.text].join(
        '\n',
      ),
    );
    sections.push(
      `List pages (mine EVERY company named inside each):\n\n${pageBlocks.join('\n\n')}`,
    );
  }
  return `${sections.join('\n\n')}\n\nExtract the matching companies per the rules.`;
}

/**
 * Parse the normalize step's STRICT-JSON output → `RawDiscoveredCompany[]`.
 * Tolerates a fence + a bare array. Drops items without a non-empty `name`;
 * coerces every other field to null when absent/ill-typed. Never throws.
 */
export function parseDiscoveredCompanies(text: string): RawDiscoveredCompany[] {
  const arr = asItemArray(text, 'companies');
  const out: RawDiscoveredCompany[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = asNonEmptyString(obj['name']);
    if (!name) continue;
    out.push({
      name,
      domain: asNonEmptyString(obj['domain']),
      fundingStage: asNonEmptyString(obj['fundingStage']),
      amountUsd: asFiniteNumber(obj['amountUsd']),
      announcedDate: asNonEmptyString(obj['announcedDate']),
      sourceUrl: asNonEmptyString(obj['sourceUrl']),
    });
  }
  return out;
}

// ── pure JSON helpers (local; trivial, self-contained) ──────────────────────

/** Strip a ```json … ``` fence if the model wrapped its output. */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? (fenced[1] as string).trim() : text.trim();
}

/**
 * Parse `text` and return the array under `key` (object form) or the bare array.
 * Returns [] on any parse failure or shape mismatch (caller drops/keeps items).
 */
function asItemArray(text: string, key: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const v = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmtList(items: readonly string[]): string {
  const clean = items.map((s) => s.trim()).filter((s) => s.length > 0);
  return clean.length ? clean.join(', ') : '(none)';
}
