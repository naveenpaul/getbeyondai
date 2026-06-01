/**
 * The provider-neutral content fetcher (content provider abstraction).
 *
 * `fetch_url` is the load-bearing link in the trust chain — a claim can be
 * cited iff the source URL was fetched first. WHAT fetches + extracts the page
 * is swappable; the Citation contract is not. This interface is that swap
 * point, mirroring `LlmProvider`: concrete adapters live in `content/providers/`
 * and the `fetch_url` tool depends only on the neutral shapes here.
 *
 * Boundary placement: a provider owns the WHOLE "URL → clean text" job (the
 * HTTP fetch AND the extraction), not just "HTML → text". This is deliberate —
 * a browser-based extractor like Crawl4AI renders the page itself and never
 * hands back raw HTML, so the seam has to start at the URL to fit it.
 *
 * What stays in the `fetch_url` tool (NOT here): creating the `Citation` row,
 * the 8 KB excerpt cap, and the tool_result output shape. Providers return the
 * full cleaned text uncapped; the tool applies policy. Keeping policy in one
 * place is what lets us swap extractors without touching the trust chain.
 */

/** One fetched + extracted page, provider-neutral. */
export interface FetchedContent {
  /** Page title, or null when the source exposes none. */
  title: string | null;
  /**
   * Cleaned, LLM-ready text (plain text or markdown depending on provider).
   * UNCAPPED — the `fetch_url` tool applies the excerpt cap before persisting.
   */
  text: string;
  /**
   * HTTP status of the fetch. Best-effort: a provider that proxies through a
   * browser service reports the upstream page status when it exposes one, else
   * 200 on success. Recorded so the audit log shows what was actually loaded.
   */
  status: number;
  /** Source content type (e.g. 'text/html'), or null when unknown. */
  contentType: string | null;
}

/**
 * A swappable "URL → cleaned text" driver. One implementation per extraction
 * strategy: `LocalExtractProvider` (zero-dependency regex strip, the self-host
 * default), `JinaReaderProvider` (clean markdown via r.jina.ai, no sidecar),
 * and `Crawl4aiProvider` (browser-rendered markdown via a local sidecar).
 */
export interface ContentProvider {
  /** Stable provider id ('local' | 'crawl4ai') — surfaced in errors/audit. */
  readonly name: string;
  /**
   * Fetch `url` and return its cleaned content. Throws `ContentProviderError`
   * on transport/extraction failure; the `fetch_url` tool lets that propagate
   * so the tool-use loop reports it to the model via `is_error: true`.
   */
  fetch(url: string): Promise<FetchedContent>;
}

/** Names the registry switches on. Keep in sync with the registry's cases. */
export type ContentProviderName = 'local' | 'jina' | 'crawl4ai';

/**
 * Neutral content-provider error. Adapters wrap transport/parse failures in
 * this so a vendor/transport error type never escapes the `content/` boundary
 * — the same quarantine discipline the LLM providers follow. No retry here
 * (the tool-use loop owns recovery by re-prompting the model).
 */
export class ContentProviderError extends Error {
  constructor(
    message: string,
    /** Provider that raised it, for the audit log / operator triage. */
    public readonly provider: string,
    /** Original error, retained for logging (never re-surfaced to callers raw). */
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ContentProviderError';
  }
}
