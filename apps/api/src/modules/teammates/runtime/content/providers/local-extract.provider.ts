import type { ContentProvider, FetchedContent } from '../content-provider';

/**
 * Local extraction provider — the zero-dependency default.
 *
 * Fetches the URL with global `fetch` and strips it to readable text with
 * regexes (script/style/comment removal + whitespace collapse). This is the
 * extraction that used to live inline in the `fetch_url` tool; it moved here
 * so it became one swappable provider instead of the only option.
 *
 * Why it's the default: it needs NO extra service. A self-hoster running
 * `docker compose up` gets working research with no Chromium sidecar to
 * provision. Point `CONTENT_PROVIDER=crawl4ai` to upgrade extraction quality
 * when noisy pages warrant the heavier dependency.
 *
 * Extraction is intentionally simple — Readability.js-style heuristics are
 * exactly what `Crawl4aiProvider` brings; duplicating them here would defeat
 * the point of the seam.
 */

export interface LocalExtractDeps {
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Soft cap on response body bytes. Above this, the body is truncated. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'getbeyond-researcher/0.1 (+https://getbeyond.ai)';

export class LocalExtractProvider implements ContentProvider {
  readonly name = 'local';

  private readonly httpFetch: typeof fetch;
  private readonly maxBytes: number;

  constructor(deps: LocalExtractDeps = {}) {
    // Resolve the global lazily — capturing at construction-time freezes
    // `globalThis.fetch` to whatever was bound then, which breaks integration
    // tests that override globalThis.fetch later.
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async fetch(url: string): Promise<FetchedContent> {
    const response = await this.httpFetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type');
    const rawText = await readUpToBytes(response, this.maxBytes);

    return {
      title: extractTitle(rawText),
      text: cleanExtract(rawText),
      status: response.status,
      contentType,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function readUpToBytes(
  response: Response,
  maxBytes: number,
): Promise<string> {
  // Modest implementation: read full text but truncate. Production-grade
  // streaming-with-cap requires plumbing reader.read(); the value here is
  // not exposing the model to multi-MB blobs through tool_result, which
  // the truncation already handles.
  const text = await response.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!match || !match[1]) return null;
  const decoded = decodeEntities(match[1].trim());
  return decoded.length > 0 ? decoded : null;
}

function cleanExtract(html: string): string {
  // Strip script + style + comments before collapsing whitespace.
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
