import {
  SearchProviderError,
  type SearchOutput,
  type SearchProvider,
  type SearchResult,
} from '../search-provider';

/**
 * SearXNG provider — a self-hosted, keyless metasearch engine (the self-host
 * default). Lets a self-hoster run the entire research loop with no paid search
 * subscription. See docs/plans/search-provider-abstraction.md.
 *
 * SearXNG proxies upstream engines (Google/Bing/DuckDuckGo/…), which rate-limit
 * automated traffic — so this provider sets a hard timeout and the operator is
 * expected to point `SEARXNG_URL` at their OWN instance (not a public one). The
 * JSON shape below is per SearXNG's `format=json` API; it MUST be verified
 * against a live instance under realistic query volume before flipping the
 * self-host default (docs §10).
 *
 * SDK quarantine (invariant #5 analogue): all SearXNG HTTP lives in this file.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SearxngProviderDeps {
  /** Base URL of the SearXNG instance, e.g. http://searxng:8080. Required. */
  baseUrl: string;
  /** Optional bearer token if the instance is auth-protected. Never logged. */
  authToken?: string;
  /** HTTP client. Defaults to global fetch. Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

/** The subset of a SearXNG JSON result we consume. */
interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string | null;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export class SearxngSearchProvider implements SearchProvider {
  readonly name = 'searxng';

  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: SearxngProviderDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.authToken = deps.authToken;
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(
    query: string,
    opts?: { count?: number },
  ): Promise<SearchOutput> {
    const count = opts?.count ?? 10;
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.httpFetch(url.toString(), {
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      throw new SearchProviderError(
        `searxng request failed: ${describeError(err)}`,
        'searxng',
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SearchProviderError(
        `searxng HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        'searxng',
      );
    }

    let json: SearxngResponse;
    try {
      json = (await response.json()) as SearxngResponse;
    } catch (err) {
      // A SearXNG instance that hasn't enabled the JSON format returns HTML
      // here — a common misconfiguration worth a clear message.
      throw new SearchProviderError(
        `searxng returned a non-JSON response (is format=json enabled?): ${describeError(err)}`,
        'searxng',
        err,
      );
    }

    const results: SearchResult[] = (json.results ?? [])
      .slice(0, count)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        description: r.content ?? '',
        age: r.publishedDate ?? null,
      }));

    return { query, results };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'request timed out';
  if (err instanceof Error) return err.message;
  return String(err);
}
