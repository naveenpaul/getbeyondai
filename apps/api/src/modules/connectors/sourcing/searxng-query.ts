import type { IcpCriteria } from './sourcing-provider';

/**
 * Compile a provider-agnostic ICP into an optimized SearXNG web-search query
 * for COMPANY DISCOVERY. Pure.
 *
 * The model never writes the raw query string — it produces the structured ICP,
 * and this deterministic compiler turns those fields into search-engine syntax
 * whose operators are VERIFIED to filter through SearXNG (2026-06-05 probe:
 * `site:`, `-exclude`, and `"exact"` all work):
 *   - exact-match the niche phrase (`"payroll software"`, not loose `payroll`)
 *   - pin geography as a quoted term
 *   - for small/early targets, bias toward company-site signals (pricing/demo)
 *   - ban the aggregators/social/job-boards that pollute a company list, plus
 *     any caller/ICP negative keywords (e.g. `-agency -consulting`)
 *   - optional `site:` engine routing (linkedin/github/g2) for intent
 *
 * Size/funding precision is NOT encoded here (web search can't filter on it
 * reliably) — the qualify+score step refines that, as with the structured
 * providers.
 */

export interface SearxngQueryOptions {
  /** Extra terms to ban (joined with the defaults), e.g. ['agency','consulting']. */
  negativeKeywords?: readonly string[];
  /** Restrict to one site for intent routing, e.g. 'linkedin.com' or 'github.com'. */
  siteScope?: string;
}

/**
 * Aggregators / social / job boards / encyclopedias that show up for company
 * searches but are NOT a company's own site — banned by default so the result
 * domains are mostly real company homepages we can turn into candidates.
 */
export const DEFAULT_NEGATIVE_TERMS: readonly string[] = [
  'agency',
  'directory',
  'glassdoor',
  'wikipedia',
];

/** Generic ICP terms that make poor exact-match niches (too broad / not a niche). */
const NON_NICHE_TERMS = new Set([
  'startup',
  'startups',
  'company',
  'companies',
  'technology',
  'tech',
  'it',
  'business',
  'pre-seed',
  'pre_seed',
  'seed',
  'series a',
  'series_a',
  'funding',
  'funded',
]);

/**
 * Pick the strictest niche phrase from the ICP: prefer a concrete industry, else
 * the most specific non-generic keyword. Returns null when the ICP names no
 * usable niche (the query then leans on geography + scale signals).
 */
export function pickNiche(icp: IcpCriteria): string | null {
  for (const industry of icp.industries) {
    const t = industry.trim();
    if (t && !NON_NICHE_TERMS.has(t.toLowerCase())) return t;
  }
  for (const keyword of icp.keywords) {
    const t = keyword.trim();
    if (t && !NON_NICHE_TERMS.has(t.toLowerCase())) return t;
  }
  return null;
}

export function compileSearxngQuery(
  icp: IcpCriteria,
  opts: SearxngQueryOptions = {},
): string {
  const parts: string[] = [];

  const niche = pickNiche(icp);
  if (niche) parts.push(`"${niche}"`);

  for (const loc of icp.locations) {
    const t = loc.trim();
    if (t) parts.push(`"${t}"`);
  }

  // Small / early-stage → bias toward a company's own site (pricing/demo pages)
  // over directories and press. ≤200 employees ≈ SMB/startup.
  if (icp.employeeCountMax !== null && icp.employeeCountMax <= 200) {
    parts.push('("pricing" OR "book a demo" OR "get started")');
  }

  const negatives = dedupeLower([
    ...DEFAULT_NEGATIVE_TERMS,
    ...(opts.negativeKeywords ?? []),
  ]);
  for (const n of negatives) parts.push(`-${n}`);

  if (opts.siteScope) parts.push(`site:${opts.siteScope.trim()}`);

  return parts.join(' ');
}

/** Lowercase + dedupe + drop blanks, preserving first-seen order. */
function dedupeLower(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const t = term.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
