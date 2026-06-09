import { describe, expect, it, vi } from 'vitest';
import { SearxngSearchProvider } from './searxng.provider';
import { SearchProviderError } from '../search-provider';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchReturning(make: () => Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => make());
}

const BASE = 'http://searxng:8080';

describe('SearxngSearchProvider', () => {
  it('has name "searxng"', () => {
    expect(new SearxngSearchProvider({ baseUrl: BASE }).name).toBe('searxng');
  });

  it('maps SearXNG results (content→description, publishedDate→age)', async () => {
    const httpFetch = fetchReturning(() =>
      jsonResponse({
        results: [
          { title: 'Acme', url: 'https://acme.com', content: 'A SaaS startup', publishedDate: '2026-04-12' },
          { title: 'Beta', url: 'https://beta.io', content: 'Raised seed' },
        ],
      }),
    );
    const provider = new SearxngSearchProvider({ baseUrl: BASE, httpFetch });
    const result = await provider.search('acme');
    expect(result).toEqual({
      query: 'acme',
      results: [
        { title: 'Acme', url: 'https://acme.com', description: 'A SaaS startup', age: '2026-04-12' },
        { title: 'Beta', url: 'https://beta.io', description: 'Raised seed', age: null },
      ],
    });
  });

  it('requests /search with q + format=json', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ results: [] }));
    await new SearxngSearchProvider({ baseUrl: `${BASE}/`, httpFetch }).search('startup funding');
    const url = new URL(String(httpFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('startup funding');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('forwards categories as a comma-separated param, omits it when absent', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ results: [] }));
    await new SearxngSearchProvider({ baseUrl: BASE, httpFetch }).search('x', {
      categories: ['general', 'news'],
    });
    expect(new URL(String(httpFetch.mock.calls[0]?.[0])).searchParams.get('categories')).toBe(
      'general,news',
    );

    const httpFetch2 = fetchReturning(() => jsonResponse({ results: [] }));
    await new SearxngSearchProvider({ baseUrl: BASE, httpFetch: httpFetch2 }).search('x');
    expect(
      new URL(String(httpFetch2.mock.calls[0]?.[0])).searchParams.get('categories'),
    ).toBeNull();
  });

  it('honors count by slicing results', async () => {
    const httpFetch = fetchReturning(() =>
      jsonResponse({
        results: [
          { title: 'a', url: 'a' },
          { title: 'b', url: 'b' },
          { title: 'c', url: 'c' },
        ],
      }),
    );
    const provider = new SearxngSearchProvider({ baseUrl: BASE, httpFetch });
    const result = await provider.search('x', { count: 2 });
    expect(result.results.map((r) => r.title)).toEqual(['a', 'b']);
  });

  it('sends a bearer token when configured, omits it otherwise', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ results: [] }));
    await new SearxngSearchProvider({ baseUrl: BASE, authToken: 't0ken', httpFetch }).search('x');
    const withToken = httpFetch.mock.calls[0]?.[1] as RequestInit;
    expect((withToken.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');

    const httpFetch2 = fetchReturning(() => jsonResponse({ results: [] }));
    await new SearxngSearchProvider({ baseUrl: BASE, httpFetch: httpFetch2 }).search('x');
    const noToken = httpFetch2.mock.calls[0]?.[1] as RequestInit;
    expect((noToken.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws SearchProviderError on a non-2xx', async () => {
    const httpFetch = fetchReturning(() => new Response('blocked', { status: 403 }));
    await expect(
      new SearxngSearchProvider({ baseUrl: BASE, httpFetch }).search('x'),
    ).rejects.toThrow(/searxng HTTP 403/);
  });

  it('gives a clear error when the instance returns non-JSON (format=json disabled)', async () => {
    const httpFetch = vi.fn(
      async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      new SearxngSearchProvider({ baseUrl: BASE, httpFetch }).search('x'),
    ).rejects.toThrow(/format=json/);
  });

  it('wraps a transport failure as SearchProviderError', async () => {
    const httpFetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      new SearxngSearchProvider({ baseUrl: BASE, httpFetch }).search('x'),
    ).rejects.toThrow(/searxng request failed: socket hang up/);
  });

  it('handles missing results (returns empty array)', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({}));
    const result = await new SearxngSearchProvider({ baseUrl: BASE, httpFetch }).search('x');
    expect(result.results).toEqual([]);
  });
});
