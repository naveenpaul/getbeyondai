import type { DiscoverySearcher } from './search-discovery.provider';
import { normalizeCompanyName, normalizeDomain } from './normalize';

/**
 * Keyless corporate-domain resolution by company name (Phase B, T4 — the D1
 * "resolve domain inline" seam for search-discovery).
 *
 * News/web search gives a company NAME but not its website. This resolves the
 * domain with ONE extra search ("<name> official website") + a pure heuristic
 * picker — NO per-company LLM call (cost-bounded). The picker skips known
 * aggregators (news/social/data sites are never a company's own domain) and
 * prefers a hostname whose first label contains a token of the company name.
 *
 * Used as `SearchDiscoverySourcingProvider`'s `resolveDomain`; a miss returns
 * null and (by the provider's `dropDomainless` default) the candidate is dropped.
 */

/** Hosts that are never a company's OWN domain — search/news/social/data aggregators. */
const AGGREGATOR_HOSTS: ReadonlySet<string> = new Set([
  'linkedin.com',
  'crunchbase.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'medium.com',
  'wikipedia.org',
  'bloomberg.com',
  'techcrunch.com',
  'forbes.com',
  'inc42.com',
  'yourstory.com',
  'entrackr.com',
  'economictimes.indiatimes.com',
  'thehindubusinessline.com',
  'zeebiz.com',
  'businesswire.com',
  'prnewswire.com',
  'pitchbook.com',
  'tracxn.com',
  'glassdoor.com',
  'indeed.com',
  'reddit.com',
  'github.com',
]);

/** Drop a leading `www.` and any deeper subdomain → registrable-ish root for aggregator matching. */
function rootHost(domain: string): string {
  const parts = domain.split('.');
  // Keep last two labels for common TLDs; last three for known 2-level TLDs.
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  // economictimes.indiatimes.com etc. are listed with 3 labels.
  return AGGREGATOR_HOSTS.has(lastThree) ? lastThree : lastTwo;
}

/**
 * Pick the most likely corporate domain for `name` from candidate URLs. Pure.
 * Skips aggregators; prefers a domain whose first label contains a name token
 * (len ≥ 3); otherwise falls back to the first non-aggregator domain; null if none.
 */
export function pickCompanyDomain(
  name: string,
  candidateUrls: ReadonlyArray<string>,
): string | null {
  const tokens = (normalizeCompanyName(name) ?? '')
    .split(' ')
    .filter((t) => t.length >= 3);

  let firstNonAggregator: string | null = null;
  for (const url of candidateUrls) {
    const domain = normalizeDomain(url);
    if (!domain) continue;
    if (AGGREGATOR_HOSTS.has(rootHost(domain))) continue;
    if (firstNonAggregator === null) firstNonAggregator = domain;
    const firstLabel = domain.split('.')[0] ?? '';
    if (tokens.some((t) => firstLabel.includes(t) || t.includes(firstLabel))) {
      return domain; // name-matched → strongest signal
    }
  }
  return firstNonAggregator;
}

/**
 * Resolve a company's domain via one web search + the pure picker. Returns null
 * on a search failure (caller treats a null domain as "drop"). The query uses
 * the company name; `official website` biases toward the homepage.
 */
export async function resolveDomainViaSearch(
  searcher: DiscoverySearcher,
  name: string,
  opts?: { count?: number },
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  let urls: string[];
  try {
    const out = await searcher.search(`${trimmed} official website`, {
      count: opts?.count ?? 5,
    });
    urls = out.results.map((r) => r.url).filter((u) => !!u);
  } catch {
    return null; // search failure → unresolved → candidate dropped upstream
  }
  return pickCompanyDomain(trimmed, urls);
}
