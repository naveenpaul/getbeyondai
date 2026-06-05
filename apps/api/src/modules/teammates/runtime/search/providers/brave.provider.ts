import {
  SearchProviderError,
  type SearchOutput,
  type SearchProvider,
  type SearchResult,
} from '../search-provider';

/**
 * Brave Search API provider — the Cloud default (paid, ToS-clean, stable under
 * programmatic load). Extracted verbatim from the legacy `brave_search` tool so
 * behavior is unchanged; the only difference is it now sits behind the
 * `SearchProvider` seam and raises the neutral `SearchProviderError`.
 *
 * Cost-aware: ~$0.005 per call against Brave.
 */

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export interface BraveProviderDeps {
  /** Brave API key. Defaults to `process.env.BRAVE_SEARCH_API_KEY`. */
  apiKey?: string;
  /** HTTP client. Defaults to global fetch. Tests inject a stub. */
  httpFetch?: typeof fetch;
}

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';

  private readonly apiKey: string;
  private readonly httpFetch: typeof fetch;

  constructor(deps: BraveProviderDeps = {}) {
    this.apiKey = deps.apiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? '';
    // Resolve globalThis.fetch lazily so tests that swap it mid-process see it.
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
  }

  async search(
    query: string,
    opts?: { count?: number },
  ): Promise<SearchOutput> {
    if (!this.apiKey || this.apiKey === 'change-me-in-production') {
      throw new SearchProviderError(
        'BRAVE_SEARCH_API_KEY is not configured',
        'brave',
      );
    }

    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(opts?.count ?? 10));

    let response: Response;
    try {
      response = await this.httpFetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey,
        },
      });
    } catch (err) {
      throw new SearchProviderError(
        `brave request failed: ${describeError(err)}`,
        'brave',
        err,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SearchProviderError(
        `brave HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        'brave',
      );
    }

    let json: BraveResponse;
    try {
      json = (await response.json()) as BraveResponse;
    } catch (err) {
      throw new SearchProviderError(
        `brave returned a non-JSON response: ${describeError(err)}`,
        'brave',
        err,
      );
    }

    const results: SearchResult[] = (json.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
      age: r.age ?? null,
    }));

    return { query, results };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'request timed out';
  if (err instanceof Error) return err.message;
  return String(err);
}
