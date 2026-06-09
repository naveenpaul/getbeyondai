import { describe, expect, it, vi } from 'vitest';
import { Crawl4aiProvider } from './crawl4ai.provider';
import { ContentProviderError } from '../content-provider';

/**
 * Crawl4aiProvider tests.
 *
 * The sidecar HTTP client: request shape (POST /crawl, bearer auth, single
 * url), response parsing across both markdown shapes, and error mapping to
 * the neutral ContentProviderError.
 */

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Crawl4aiProvider — requests', () => {
  it('POSTs the url to /crawl and parses fit_markdown + title', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          results: [
            {
              success: true,
              status_code: 200,
              markdown: {
                raw_markdown: '# Raw\nnoisy nav links',
                fit_markdown: '# Acme\nClean main content.',
              },
              metadata: { title: 'Acme Inc' },
            },
          ],
        }),
    );
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://crawl4ai:11235',
      httpFetch,
    });

    const result = await provider.fetch('https://acme.com');
    expect(result.title).toBe('Acme Inc');
    expect(result.text).toBe('# Acme\nClean main content.'); // fit preferred over raw
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/markdown');

    const [calledUrl, init] = httpFetch.mock.calls[0]!;
    expect(calledUrl).toBe('http://crawl4ai:11235/crawl');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      urls: ['https://acme.com'],
    });
  });

  it('attaches a BM25 content filter carrying the query when one is given', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ results: [{ success: true, markdown: { fit_markdown: 'x' } }] }),
    );
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://crawl4ai:11235',
      httpFetch,
    });
    await provider.fetch('https://list.com/top', {
      query: 'funded IT startups in Bengaluru',
    });
    const body = JSON.parse(httpFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.urls).toEqual(['https://list.com/top']);
    const filter =
      body.crawler_config?.params?.markdown_generator?.params?.content_filter;
    expect(filter?.type).toBe('BM25ContentFilter');
    expect(filter?.params?.user_query).toBe('funded IT startups in Bengaluru');
  });

  it('sends a plain body (no filter) when no query is given', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ results: [{ success: true, markdown: 'x' }] }),
    );
    await new Crawl4aiProvider({ baseUrl: 'http://c:1', httpFetch }).fetch(
      'https://x.example',
    );
    expect(JSON.parse(httpFetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      urls: ['https://x.example'],
    });
  });

  it('retries WITHOUT the filter when the server rejects the BM25 config', async () => {
    // First call (with filter) 422s; second (plain) succeeds → page not lost.
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'bad config' }, { status: 422 }))
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ success: true, markdown: 'recovered' }] }),
      );
    const provider = new Crawl4aiProvider({ baseUrl: 'http://c:1', httpFetch });
    const result = await provider.fetch('https://list.com/top', { query: 'q' });
    expect(result.text).toBe('recovered');
    expect(httpFetch).toHaveBeenCalledTimes(2);
    // First body carried the filter; the retry body did not.
    expect(JSON.parse(httpFetch.mock.calls[0]?.[1]?.body as string).crawler_config).toBeDefined();
    expect(JSON.parse(httpFetch.mock.calls[1]?.[1]?.body as string).crawler_config).toBeUndefined();
  });

  it('does not retry a filter-less (no-query) failure', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({ detail: 'boom' }, { status: 500 }),
    );
    await expect(
      new Crawl4aiProvider({ baseUrl: 'http://c:1', httpFetch }).fetch('https://x.example'),
    ).rejects.toThrow(ContentProviderError);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('sends a bearer Authorization header when a token is configured', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ results: [{ success: true, markdown: 'x' }] }),
    );
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://crawl4ai:11235',
      apiToken: 'secret-token',
      httpFetch,
    });
    await provider.fetch('https://x.example');
    expect(httpFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
  });

  it('omits Authorization when no token is configured', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ results: [{ success: true, markdown: 'x' }] }),
    );
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://crawl4ai:11235',
      httpFetch,
    });
    await provider.fetch('https://x.example');
    const headers = httpFetch.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it('trims a trailing slash on baseUrl so the path never doubles', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ results: [{ success: true, markdown: 'x' }] }),
    );
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://crawl4ai:11235/',
      httpFetch,
    });
    await provider.fetch('https://x.example');
    expect(httpFetch.mock.calls[0]?.[0]).toBe('http://crawl4ai:11235/crawl');
  });
});

describe('Crawl4aiProvider — response shapes', () => {
  it('falls back to raw_markdown when fit_markdown is absent', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () =>
        jsonResponse({
          results: [{ success: true, markdown: { raw_markdown: '# Raw only' } }],
        }),
      ),
    });
    const result = await provider.fetch('https://x.example');
    expect(result.text).toBe('# Raw only');
  });

  it('accepts a bare-string markdown (older server build)', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () =>
        jsonResponse({ results: [{ success: true, markdown: '# String form' }] }),
      ),
    });
    const result = await provider.fetch('https://x.example');
    expect(result.text).toBe('# String form');
  });

  it('defaults status to 200 and title to null when absent', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () =>
        jsonResponse({ results: [{ success: true, markdown: 'content' }] }),
      ),
    });
    const result = await provider.fetch('https://x.example');
    expect(result.status).toBe(200);
    expect(result.title).toBeNull();
  });
});

describe('Crawl4aiProvider — errors', () => {
  it('rejects construction without a baseUrl', () => {
    expect(
      () => new Crawl4aiProvider({ baseUrl: '', httpFetch: vi.fn() }),
    ).toThrow(ContentProviderError);
  });

  it('throws ContentProviderError when the crawl reports success:false', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () =>
        jsonResponse({
          results: [{ success: false, error_message: 'blocked by robots' }],
        }),
      ),
    });
    await expect(provider.fetch('https://blocked.example')).rejects.toThrow(
      /blocked by robots/,
    );
  });

  it('throws on a non-2xx HTTP response from the sidecar', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () =>
        jsonResponse({ detail: 'unauthorized' }, { status: 401 }),
      ),
    });
    await expect(provider.fetch('https://x.example')).rejects.toThrow(
      ContentProviderError,
    );
  });

  it('throws when the response has no results', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () => jsonResponse({ results: [] })),
    });
    await expect(provider.fetch('https://x.example')).rejects.toThrow(
      /no results/,
    );
  });

  it('throws when the crawl succeeds but yields empty markdown', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () =>
        jsonResponse({
          results: [{ success: true, markdown: { fit_markdown: '', raw_markdown: '' } }],
        }),
      ),
    });
    await expect(provider.fetch('https://x.example')).rejects.toThrow(
      /no markdown/,
    );
  });

  it('wraps a transport failure in ContentProviderError', async () => {
    const provider = new Crawl4aiProvider({
      baseUrl: 'http://c:1',
      httpFetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const err = await provider.fetch('https://x.example').catch((e) => e);
    expect(err).toBeInstanceOf(ContentProviderError);
    expect((err as ContentProviderError).provider).toBe('crawl4ai');
    expect((err as ContentProviderError).cause).toBeInstanceOf(Error);
  });
});
