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
export const MAX_DISCOVERY_QUERIES = 3;

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

export const DISCOVERY_NORMALIZE_SYSTEM_PROMPT = `You extract COMPANIES that recently raised funding (or otherwise match the search intent) from web/news search results.

Rules:
- Output only operating COMPANIES that are the subject of the result. DROP venture funds, accelerators, "fund I/II/III" raises, ecosystem/roundup pieces, league tables, and any result that is not a single company raising or matching.
- Do not invent companies not present in the results. If a result names no clear company, skip it.
- Pull the company's own website domain when present in the snippet; otherwise leave domain null (it will be resolved later). The result URL is the news source, NOT the company domain.
- Capture funding stage, USD amount, and announced date ONLY when stated; else null.

Return STRICT JSON, no prose:
{"companies":[{"name":"<string>","domain":"<string|null>","fundingStage":"<string|null>","amountUsd":<number|null>,"announcedDate":"<string|null>","sourceUrl":"<result url|null>"}]}`;

/** Build the normalize user turn from raw search hits (title/url/snippet/age). */
export function buildNormalizeUserPrompt(
  results: ReadonlyArray<{
    title: string;
    url: string;
    description: string;
    age: string | null;
  }>,
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
  return `Search results:\n\n${blocks.join('\n\n')}\n\nExtract the matching companies per the rules.`;
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
