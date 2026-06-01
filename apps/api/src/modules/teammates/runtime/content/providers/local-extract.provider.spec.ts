import { describe, expect, it, vi } from 'vitest';
import { LocalExtractProvider } from './local-extract.provider';

/**
 * LocalExtractProvider tests.
 *
 * These are the extraction-correctness tests that used to live in
 * `fetch-url.spec.ts` — they moved with the logic. The tool spec now only
 * covers the Citation/cap/output contract against a fake provider.
 */

function htmlResponse(html: string, init: { status?: number } = {}): Response {
  return new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('LocalExtractProvider', () => {
  it('extracts title + readable text, stripping script/style/comments', async () => {
    const html = `
      <html>
        <head><title>Acme Inc — homepage</title><style>.x{color:red}</style></head>
        <body>
          <script>window.foo = 1</script>
          <!-- hidden note -->
          <h1>Welcome to Acme</h1>
          <p>We are a <strong>SaaS startup</strong> founded in 2022.</p>
        </body>
      </html>
    `;
    const provider = new LocalExtractProvider({
      httpFetch: vi.fn(async () => htmlResponse(html)),
    });

    const result = await provider.fetch('https://acme.com');
    expect(result.title).toBe('Acme Inc — homepage');
    expect(result.text).toContain('Welcome to Acme');
    expect(result.text).toContain('SaaS startup');
    expect(result.text).not.toContain('window.foo');
    expect(result.text).not.toContain('color:red');
    expect(result.text).not.toContain('hidden note');
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/html');
  });

  it('returns null title when the page has no <title>', async () => {
    const provider = new LocalExtractProvider({
      httpFetch: vi.fn(async () =>
        htmlResponse('<html><body><p>No title here</p></body></html>'),
      ),
    });
    const result = await provider.fetch('https://no-title.example');
    expect(result.title).toBeNull();
    expect(result.text).toContain('No title here');
  });

  it('decodes common HTML entities in title + text', async () => {
    const provider = new LocalExtractProvider({
      httpFetch: vi.fn(async () =>
        htmlResponse(
          '<html><head><title>Acme &amp; Co.</title></head><body><p>2 &lt; 3 &amp; 4 &gt; 1</p></body></html>',
        ),
      ),
    });
    const result = await provider.fetch('https://e.example');
    expect(result.title).toBe('Acme & Co.');
    expect(result.text).toContain('2 < 3 & 4 > 1');
  });

  it('records the actual HTTP status (including 4xx)', async () => {
    const provider = new LocalExtractProvider({
      httpFetch: vi.fn(async () =>
        htmlResponse('<title>Not Found</title>', { status: 404 }),
      ),
    });
    const result = await provider.fetch('https://missing.example/page');
    expect(result.status).toBe(404);
  });

  it('sends a User-Agent identifying getbeyond', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        htmlResponse('<title>x</title>'),
    );
    const provider = new LocalExtractProvider({ httpFetch });
    await provider.fetch('https://x.example');
    expect(httpFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('getbeyond'),
    });
  });

  it('caps the raw body to maxBytes before extracting', async () => {
    const massive = '<html><body>' + 'a'.repeat(100_000) + '</body></html>';
    const provider = new LocalExtractProvider({
      httpFetch: vi.fn(async () => htmlResponse(massive)),
      maxBytes: 1000,
    });
    const result = await provider.fetch('https://big.example');
    expect(result.text.length).toBeLessThan(2000);
  });
});
