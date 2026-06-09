/**
 * The provider-neutral web-search driver (search provider abstraction).
 *
 * Web search is the Researcher's primary discovery tool. WHAT engine serves it
 * is swappable; the trust chain is not. This interface is that swap point,
 * mirroring `ContentProvider` and `LlmProvider`: concrete adapters live in
 * `search/providers/` and the `web_search` tool depends only on the neutral
 * shapes here.
 *
 * Search only DISCOVERS sources — a result is never a Citation. A claim can be
 * cited iff its URL was `fetch_url`-ed first (invariant #4). Swapping the search
 * backend therefore can't touch the trust model; it only changes which URLs the
 * model gets to consider fetching.
 *
 * Provider: `SearxngSearchProvider` (self-hosted, keyless metasearch) is the
 * only backend — search is keyless across both self-host and Cloud. The seam is
 * kept so another engine can be added later without touching the trust chain.
 * See docs/plans/search-provider-abstraction.md.
 */

/** One search hit, provider-neutral. Stable across engines so the `web_search`
 *  tool's output (and the Researcher) are unchanged. */
export interface SearchResult {
  title: string;
  url: string;
  description: string;
  /** ISO-8601 timestamp the source reported, or null when none. */
  age: string | null;
}

export interface SearchOutput {
  query: string;
  results: SearchResult[];
}

/** A swappable web-search backend. One implementation per engine. */
export interface SearchProvider {
  /** Stable provider id ('searxng') — surfaced in errors/audit. */
  readonly name: string;
  /**
   * Run a web search and return up to ~`count` results. `categories` narrows the
   * engines the backend consults (e.g. `['general','news']`); a provider with no
   * notion of categories ignores it. Throws `SearchProviderError` on
   * transport/engine failure; the `web_search` tool lets it propagate so the
   * tool-use loop reports it to the model via `is_error: true` (the model can
   * then retry or abstain).
   */
  search(
    query: string,
    opts?: { count?: number; categories?: readonly string[] },
  ): Promise<SearchOutput>;
}

/** Names the registry switches on. Keep in sync with the registry's cases.
 *  Single-member today; the union is retained so adding an engine is additive. */
export type SearchProviderName = 'searxng';

/**
 * Neutral search-provider error. Adapters wrap transport/parse failures in this
 * so a vendor/transport error type never escapes the `search/` boundary — the
 * same quarantine discipline the LLM + content providers follow. No retry here
 * beyond what a provider does internally; the tool-use loop owns model recovery.
 */
export class SearchProviderError extends Error {
  constructor(
    message: string,
    /** Provider that raised it, for the audit log / operator triage. */
    public readonly provider: string,
    /** Original error, retained for logging (never re-surfaced raw to callers). */
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }
}
