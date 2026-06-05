import { describe, expect, it, vi } from 'vitest';
import { BraveSearchProvider } from './brave.provider';
import { SearchProviderError } from '../search-provider';

/** Ported from the legacy brave-search.spec.ts — behavior must be preserved. */

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchReturning(make: () => Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => make());
}

describe('BraveSearchProvider', () => {
  it('has name "brave"', () => {
    expect(new BraveSearchProvider({ apiKey: 'k' }).name).toBe('brave');
  });

  it('returns normalized results from a successful response', async () => {
    const httpFetch = fetchReturning(() =>
      jsonResponse({
        web: {
          results: [
            { title: 'Acme Inc', url: 'https://acme.com', description: 'A SaaS startup', age: '2026-04-12' },
            { title: 'Acme on TC', url: 'https://tc.com/acme', description: 'Raised $5M' },
          ],
        },
      }),
    );
    const provider = new BraveSearchProvider({ apiKey: 'k', httpFetch });
    const result = await provider.search('Acme funding');
    expect(result).toEqual({
      query: 'Acme funding',
      results: [
        { title: 'Acme Inc', url: 'https://acme.com', description: 'A SaaS startup', age: '2026-04-12' },
        { title: 'Acme on TC', url: 'https://tc.com/acme', description: 'Raised $5M', age: null },
      ],
    });
  });

  it('attaches the X-Subscription-Token header', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ web: { results: [] } }));
    await new BraveSearchProvider({ apiKey: 'secret-key', httpFetch }).search('x');
    const init = httpFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('secret-key');
  });

  it('serializes query + count, defaulting count to 10', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ web: { results: [] } }));
    const provider = new BraveSearchProvider({ apiKey: 'k', httpFetch });
    await provider.search('startup funding', { count: 5 });
    await provider.search('again');
    expect(new URL(String(httpFetch.mock.calls[0]?.[0])).searchParams.get('q')).toBe('startup funding');
    expect(new URL(String(httpFetch.mock.calls[0]?.[0])).searchParams.get('count')).toBe('5');
    expect(new URL(String(httpFetch.mock.calls[1]?.[0])).searchParams.get('count')).toBe('10');
  });

  it('throws SearchProviderError on a non-2xx, surfacing the status', async () => {
    const httpFetch = fetchReturning(() => new Response('rate limited', { status: 429 }));
    const provider = new BraveSearchProvider({ apiKey: 'k', httpFetch });
    await expect(provider.search('x')).rejects.toBeInstanceOf(SearchProviderError);
    await expect(provider.search('x')).rejects.toThrow(/brave HTTP 429/);
  });

  it('throws when the key is unset or a placeholder', async () => {
    await expect(
      new BraveSearchProvider({ apiKey: '', httpFetch: vi.fn() }).search('x'),
    ).rejects.toThrow(/not configured/);
    await expect(
      new BraveSearchProvider({ apiKey: 'change-me-in-production', httpFetch: vi.fn() }).search('x'),
    ).rejects.toThrow(/not configured/);
  });

  it('wraps a transport failure as SearchProviderError', async () => {
    const httpFetch = vi.fn(async () => {
      throw new Error('econnreset');
    });
    await expect(
      new BraveSearchProvider({ apiKey: 'k', httpFetch }).search('x'),
    ).rejects.toThrow(/brave request failed: econnreset/);
  });

  it('throws on a non-JSON body', async () => {
    const httpFetch = vi.fn(
      async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      new BraveSearchProvider({ apiKey: 'k', httpFetch }).search('x'),
    ).rejects.toThrow(/non-JSON/);
  });

  it('handles missing web.results (returns empty array)', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({}));
    const result = await new BraveSearchProvider({ apiKey: 'k', httpFetch }).search('x');
    expect(result.results).toEqual([]);
  });
});
