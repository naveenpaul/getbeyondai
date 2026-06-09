import { Logger } from '@nestjs/common';
import {
  ContentProviderError,
  type ContentProvider,
  type FetchedContent,
} from '../content-provider';

/**
 * Crawl4AI provider — browser-rendered markdown via a self-hosted sidecar.
 *
 * Talks to the official `unclecode/crawl4ai` Docker image's REST server
 * (`POST /crawl`), which renders the page in a real (Playwright) browser and
 * returns clean, LLM-ready markdown. This is the extraction upgrade over
 * `LocalExtractProvider` for JS-heavy / noisy pages — at the cost of running a
 * ~1 GB Chromium container, so it's opt-in (`CONTENT_PROVIDER=crawl4ai`), not
 * the default.
 *
 * Deployment: runs as an internal-only compose service (`http://crawl4ai:11235`),
 * never exposed publicly. Set `CRAWL4AI_API_TOKEN` to gate the endpoint.
 *
 * Licensing: Crawl4AI is Apache-2.0 with an attribution clause — the product's
 * NOTICE/credits must acknowledge the project. Using the prebuilt image does
 * not waive that.
 *
 * Response shape (defensive): the server wraps results as
 * `{ results: [{ success, status_code?, markdown, metadata? }] }`. `markdown`
 * is a string on older builds and a `{ raw_markdown, fit_markdown }` object on
 * newer ones; we prefer `fit_markdown` (denoised main content) and fall back to
 * `raw_markdown` / the string form so a version bump doesn't silently break us.
 */

export interface Crawl4aiDeps {
  /** Base URL of the Crawl4AI REST server, e.g. http://crawl4ai:11235. */
  baseUrl: string;
  /** Optional bearer token (CRAWL4AI_API_TOKEN). Sent as Authorization when set. */
  apiToken?: string;
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30s — browser renders can be slow. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PROVIDER_NAME = 'crawl4ai';

/** Newer Crawl4AI returns a structured markdown object; older a bare string. */
interface MarkdownResult {
  raw_markdown?: string;
  fit_markdown?: string;
}

interface Crawl4aiCrawlResult {
  success?: boolean;
  status_code?: number;
  error_message?: string;
  markdown?: string | MarkdownResult;
  metadata?: { title?: string | null };
}

interface Crawl4aiResponse {
  results?: Crawl4aiCrawlResult[];
}

export class Crawl4aiProvider implements ContentProvider {
  readonly name = PROVIDER_NAME;

  private readonly logger = new Logger(Crawl4aiProvider.name);
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: Crawl4aiDeps) {
    if (!deps.baseUrl) {
      throw new ContentProviderError(
        'Crawl4aiProvider requires a baseUrl (CRAWL4AI_URL)',
        PROVIDER_NAME,
      );
    }
    // Trim a trailing slash so `${baseUrl}/crawl` never doubles up.
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.apiToken = deps.apiToken;
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(
    url: string,
    opts?: { query?: string },
  ): Promise<FetchedContent> {
    const query = opts?.query?.trim() || undefined;
    let result: Crawl4aiCrawlResult;
    try {
      result = await this.callCrawl(url, query);
    } catch (err) {
      // The BM25 filter config is version-sensitive (Crawl4AI's `{type,params}`
      // envelope changes across releases). If the server rejects it (e.g. a 422
      // validation error), retry once WITHOUT the filter so we still get the
      // default fit_markdown rather than losing the page entirely. A genuine
      // page failure (success:false) returns normally from callCrawl and is
      // handled below — it never reaches this retry.
      if (!query || !(err instanceof ContentProviderError)) throw err;
      this.logger.warn(
        `BM25-focused crawl rejected for ${url}; retrying without the filter`,
      );
      result = await this.callCrawl(url);
    }

    if (result.success === false) {
      throw new ContentProviderError(
        `Crawl4AI failed to crawl ${url}` +
          (result.error_message ? `: ${result.error_message}` : ''),
        PROVIDER_NAME,
      );
    }

    const text = extractMarkdown(result.markdown);
    if (text === null) {
      throw new ContentProviderError(
        `Crawl4AI returned no markdown for ${url}`,
        PROVIDER_NAME,
      );
    }

    const title = result.metadata?.title?.trim();
    return {
      title: title ? title : null,
      text,
      status: result.status_code ?? 200,
      contentType: 'text/markdown',
    };
  }

  private async callCrawl(
    url: string,
    query?: string,
  ): Promise<Crawl4aiCrawlResult> {
    // AbortController bounds slow browser renders so one stuck page can't
    // hang the whole AgentRun past its budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.httpFetch(`${this.baseUrl}/crawl`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.apiToken
            ? { Authorization: `Bearer ${this.apiToken}` }
            : {}),
        },
        body: JSON.stringify(buildCrawlBody(url, query)),
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
        `Crawl4AI request to ${this.baseUrl} failed: ${reason}`,
        PROVIDER_NAME,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ContentProviderError(
        `Crawl4AI HTTP ${response.status}` +
          (body ? `: ${body.slice(0, 200)}` : ''),
        PROVIDER_NAME,
      );
    }

    let json: Crawl4aiResponse;
    try {
      json = (await response.json()) as Crawl4aiResponse;
    } catch (err) {
      throw new ContentProviderError(
        'Crawl4AI returned a non-JSON response',
        PROVIDER_NAME,
        err,
      );
    }

    const result = json.results?.[0];
    if (!result) {
      throw new ContentProviderError(
        `Crawl4AI returned no results for ${url}`,
        PROVIDER_NAME,
      );
    }
    return result;
  }
}

/**
 * Build the `/crawl` request body. Plain `{ urls: [url] }` by default (Crawl4AI
 * applies its default pruning fit_markdown). When `query` is given, attach a
 * BM25 content filter so the returned `fit_markdown` is trimmed to the part of
 * the page matching the search intent — e.g. a mined "Top N startups" listicle
 * keeps the company list and drops nav/ads/unrelated sections.
 *
 * NOTE: Crawl4AI's REST config uses a nested `{type, params}` envelope whose
 * exact shape is version-sensitive. `fetch()` retries without this filter if the
 * server rejects it, so a version skew degrades to default fit_markdown rather
 * than failing the page.
 */
export function buildCrawlBody(
  url: string,
  query?: string,
): Record<string, unknown> {
  if (!query) return { urls: [url] };
  return {
    urls: [url],
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: {
        markdown_generator: {
          type: 'DefaultMarkdownGenerator',
          params: {
            content_filter: {
              type: 'BM25ContentFilter',
              params: { user_query: query },
            },
          },
        },
      },
    },
  };
}

/**
 * Pull the best available markdown out of either response shape. Prefers the
 * denoised `fit_markdown`, then `raw_markdown`, then the bare-string form.
 * Returns null when none is present or all are empty.
 */
function extractMarkdown(
  markdown: string | MarkdownResult | undefined,
): string | null {
  if (markdown == null) return null;
  if (typeof markdown === 'string') {
    return markdown.length > 0 ? markdown : null;
  }
  const text = markdown.fit_markdown || markdown.raw_markdown || '';
  return text.length > 0 ? text : null;
}
