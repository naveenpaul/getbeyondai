import {
  ContentProviderError,
  type ContentProvider,
  type FetchedContent,
} from '../content-provider';

/**
 * Jina Reader provider — clean markdown via r.jina.ai, no sidecar.
 *
 * The lightweight middle ground between `LocalExtractProvider` (crude regex,
 * zero infra) and `Crawl4aiProvider` (best extraction, ~1GB Chromium sidecar).
 * Jina Reader takes a URL and returns LLM-ready markdown; the hosted endpoint
 * needs no extra service, and r.jina.ai is itself open-source (Apache-2.0, no
 * attribution clause) and self-hostable if a deployment wants to keep traffic
 * in-house.
 *
 * Transport: GET `${baseUrl}/<targetUrl>` with `Accept: application/json` so we
 * parse a structured `{ data: { title, content } }` envelope instead of
 * scraping Jina's text header block. An optional API key (`JINA_API_KEY`) is
 * sent as a bearer token for higher rate limits.
 *
 * Privacy note: with the hosted endpoint, target URLs are sent to a third party
 * (Jina). For sensitive deployments prefer `local`/`crawl4ai`, or point
 * `JINA_READER_URL` at a self-hosted Reader.
 */

export interface JinaReaderDeps {
  /** Reader base URL. Default https://r.jina.ai. Override for a self-hosted Reader. */
  baseUrl?: string;
  /** Optional API key (JINA_API_KEY). Sent as a bearer token when set. */
  apiKey?: string;
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://r.jina.ai';
const DEFAULT_TIMEOUT_MS = 30_000;
const PROVIDER_NAME = 'jina';

/** Jina Reader's JSON envelope (the fields we consume). */
interface JinaReaderResponse {
  data?: {
    title?: string | null;
    content?: string;
  };
}

export class JinaReaderProvider implements ContentProvider {
  readonly name = PROVIDER_NAME;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: JinaReaderDeps = {}) {
    // Trim a trailing slash so `${baseUrl}/${url}` never doubles up.
    this.baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = deps.apiKey;
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(url: string): Promise<FetchedContent> {
    const data = await this.callReader(url);

    const content = data.content;
    if (!content) {
      throw new ContentProviderError(
        `Jina Reader returned no content for ${url}`,
        PROVIDER_NAME,
      );
    }

    const title = data.title?.trim();
    return {
      title: title ? title : null,
      text: content,
      status: 200,
      contentType: 'text/markdown',
    };
  }

  private async callReader(
    url: string,
  ): Promise<NonNullable<JinaReaderResponse['data']>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // The target URL is a path segment, not a query param — Jina expects
    // `https://r.jina.ai/https://example.com/page`. encodeURI preserves the
    // URL's own structure while escaping spaces and stray characters.
    const target = `${this.baseUrl}/${encodeURI(url)}`;

    let response: Response;
    try {
      response = await this.httpFetch(target, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new ContentProviderError(
        `Jina Reader request to ${this.baseUrl} failed: ${reason}`,
        PROVIDER_NAME,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ContentProviderError(
        `Jina Reader HTTP ${response.status}` +
          (body ? `: ${body.slice(0, 200)}` : ''),
        PROVIDER_NAME,
      );
    }

    let json: JinaReaderResponse;
    try {
      json = (await response.json()) as JinaReaderResponse;
    } catch (err) {
      throw new ContentProviderError(
        'Jina Reader returned a non-JSON response',
        PROVIDER_NAME,
        err,
      );
    }

    if (!json.data) {
      throw new ContentProviderError(
        `Jina Reader returned no data for ${url}`,
        PROVIDER_NAME,
      );
    }
    return json.data;
  }
}
