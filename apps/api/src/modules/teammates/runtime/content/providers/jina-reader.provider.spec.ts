import { describe, expect, it, vi } from 'vitest';
import { JinaReaderProvider } from './jina-reader.provider';
import { ContentProviderError } from '../content-provider';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('JinaReaderProvider — requests', () => {
  it('GETs r.jina.ai/<url> with JSON accept and parses title + content', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          code: 200,
          data: { title: 'Acme Inc', content: '# Acme\nClean markdown.' },
        }),
    );
    const provider = new JinaReaderProvider({ httpFetch });

    const result = await provider.fetch('https://acme.com/page');
    expect(result.title).toBe('Acme Inc');
    expect(result.text).toBe('# Acme\nClean markdown.');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/markdown');

    const [calledUrl, init] = httpFetch.mock.calls[0]!;
    expect(calledUrl).toBe('https://r.jina.ai/https://acme.com/page');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Accept: 'application/json' });
  });

  it('sends a bearer Authorization header when an API key is configured', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { content: 'x' } }),
    );
    const provider = new JinaReaderProvider({ apiKey: 'jina-key', httpFetch });
    await provider.fetch('https://x.example');
    expect(httpFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer jina-key',
    });
  });

  it('omits Authorization when no key is configured', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { content: 'x' } }),
    );
    const provider = new JinaReaderProvider({ httpFetch });
    await provider.fetch('https://x.example');
    const headers = httpFetch.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it('honors a custom (self-hosted) baseUrl and trims a trailing slash', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { content: 'x' } }),
    );
    const provider = new JinaReaderProvider({
      baseUrl: 'http://reader.internal:3000/',
      httpFetch,
    });
    await provider.fetch('https://x.example');
    expect(httpFetch.mock.calls[0]?.[0]).toBe(
      'http://reader.internal:3000/https://x.example',
    );
  });
});

describe('JinaReaderProvider — response shapes', () => {
  it('defaults title to null when absent', async () => {
    const provider = new JinaReaderProvider({
      httpFetch: vi.fn(async () => jsonResponse({ data: { content: 'body' } })),
    });
    const result = await provider.fetch('https://x.example');
    expect(result.title).toBeNull();
    expect(result.text).toBe('body');
  });
});

describe('JinaReaderProvider — errors', () => {
  it('throws ContentProviderError on a non-2xx response', async () => {
    const provider = new JinaReaderProvider({
      httpFetch: vi.fn(async () =>
        jsonResponse({ detail: 'rate limited' }, { status: 429 }),
      ),
    });
    await expect(provider.fetch('https://x.example')).rejects.toThrow(
      ContentProviderError,
    );
  });

  it('throws when the envelope has no data', async () => {
    const provider = new JinaReaderProvider({
      httpFetch: vi.fn(async () => jsonResponse({ code: 200 })),
    });
    await expect(provider.fetch('https://x.example')).rejects.toThrow(/no data/);
  });

  it('throws when data has empty content', async () => {
    const provider = new JinaReaderProvider({
      httpFetch: vi.fn(async () =>
        jsonResponse({ data: { title: 'T', content: '' } }),
      ),
    });
    await expect(provider.fetch('https://x.example')).rejects.toThrow(
      /no content/,
    );
  });

  it('wraps a transport failure in ContentProviderError', async () => {
    const provider = new JinaReaderProvider({
      httpFetch: vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    });
    const err = await provider.fetch('https://x.example').catch((e) => e);
    expect(err).toBeInstanceOf(ContentProviderError);
    expect((err as ContentProviderError).provider).toBe('jina');
    expect((err as ContentProviderError).cause).toBeInstanceOf(Error);
  });
});
