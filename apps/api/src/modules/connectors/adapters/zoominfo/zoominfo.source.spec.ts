import { describe, expect, it, vi } from 'vitest';
import {
  ZoomInfoAuthError,
  ZoomInfoClient,
  ZoomInfoServerError,
} from './zoominfo.source';

const OAUTH_URL = 'https://api.zoominfo.com/gtm/oauth/v1/token';
const SEARCH_URL = 'https://api.zoominfo.com/gtm/data/v1/companies/search';
const CONTACTS_URL = 'https://api.zoominfo.com/gtm/data/v1/contacts/search';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub that answers per-URL with a queue of responses. */
function stubFetch(
  routes: Record<string, Array<() => Response | Promise<Response>>>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const queue = routes[url];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return queue.shift()!();
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls };
}

/** Recorded calls to a given URL (typed non-empty access for assertions). */
function callsTo(
  calls: Array<{ url: string; init: RequestInit }>,
  url: string,
) {
  return calls.filter((c) => c.url === url);
}

/** The nth recorded call, asserted present. */
function nthCall(
  calls: Array<{ url: string; init: RequestInit }>,
  index: number,
): { url: string; init: RequestInit } {
  const call = calls[index];
  if (!call) throw new Error(`expected a call at index ${index}`);
  return call;
}

function headersOf(call: { init: RequestInit }): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function tokenBody(token: string, expiresIn?: number) {
  return expiresIn === undefined
    ? { access_token: token }
    : { access_token: token, expires_in: expiresIn };
}

/** Default client wiring used by most tests: a configured secret + a fixed clock. */
function makeClient(
  fetchMock: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof ZoomInfoClient>[0]> = {},
) {
  let clock = 1_000_000;
  return new ZoomInfoClient({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    httpFetch: fetchMock,
    now: () => clock,
    ...overrides,
  });
}

describe('ZoomInfoClient', () => {
  describe('searchCompanies', () => {
    it('mints a token then posts the JSON:API company search', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('opaque-token'))],
        [SEARCH_URL]: [() => jsonResponse({ data: [{ id: 'zi-1' }] })],
      });
      const client = makeClient(fetchMock);

      const result = await client.searchCompanies({ companyName: 'ZoomInfo' });

      expect(result).toEqual({ data: [{ id: 'zi-1' }] });

      // OAuth request: client-credentials, form-encoded, with our UA.
      const oauth = nthCall(calls, 0);
      expect(oauth.url).toBe(OAUTH_URL);
      expect(oauth.init.method).toBe('POST');
      const oauthHeaders = headersOf(oauth);
      expect(oauthHeaders['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(oauthHeaders['User-Agent']).toBe('getbeyond-zoominfo-connector/1.0');
      expect(String(oauth.init.body)).toContain('grant_type=client_credentials');
      expect(String(oauth.init.body)).toContain('client_secret=test-secret');

      // Search request: JSON:API headers, verbatim Bearer, documented body shape.
      const search = nthCall(calls, 1);
      expect(search.url).toBe(SEARCH_URL);
      const searchHeaders = headersOf(search);
      expect(searchHeaders.Accept).toBe('application/vnd.api+json');
      expect(searchHeaders['Content-Type']).toBe('application/vnd.api+json');
      expect(searchHeaders.Authorization).toBe('Bearer opaque-token');
      expect(searchHeaders['User-Agent']).toBe('getbeyond-zoominfo-connector/1.0');
      expect(JSON.parse(String(search.init.body))).toEqual({
        data: { type: 'CompanySearch', attributes: { companyName: 'ZoomInfo' } },
      });
    });

    it('copies the opaque token verbatim — never trims or reformats it', async () => {
      // A token with surrounding whitespace + JWT dots must survive untouched.
      const opaque = '  aaa.bbb.ccc\t';
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody(opaque))],
        [SEARCH_URL]: [() => jsonResponse({ data: [] })],
      });
      const client = makeClient(fetchMock);

      await client.searchCompanies({ companyName: 'Acme' });

      const searchHeaders = headersOf(nthCall(calls, 1));
      expect(searchHeaders.Authorization).toBe(`Bearer ${opaque}`);
    });

    it('passes unknown attributes straight through to the vendor', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t'))],
        [SEARCH_URL]: [() => jsonResponse({ data: [] })],
      });
      const client = makeClient(fetchMock);

      await client.searchCompanies({
        companyName: 'Acme',
        industryCodes: [123],
      } as Record<string, unknown>);

      expect(JSON.parse(String(nthCall(calls, 1).init.body)).data.attributes).toEqual({
        companyName: 'Acme',
        industryCodes: [123],
      });
    });
  });

  describe('searchContacts', () => {
    it('posts the JSON:API contact search to the contacts endpoint', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t'))],
        [CONTACTS_URL]: [() => jsonResponse({ data: [{ id: 'c-1', type: 'Contact' }] })],
      });
      const client = makeClient(fetchMock);

      const result = await client.searchContacts({
        companyName: 'ZoomInfo',
        jobTitle: 'CEO',
      });

      expect(result).toEqual({ data: [{ id: 'c-1', type: 'Contact' }] });
      const search = nthCall(calls, 1);
      expect(search.url).toBe(CONTACTS_URL);
      const headers = headersOf(search);
      expect(headers.Accept).toBe('application/vnd.api+json');
      expect(headers.Authorization).toBe('Bearer t');
      expect(JSON.parse(String(search.init.body))).toEqual({
        data: {
          type: 'ContactSearch',
          attributes: { companyName: 'ZoomInfo', jobTitle: 'CEO' },
        },
      });
    });

    it('refreshes the token once on a 401 and retries the contact search', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [
          () => jsonResponse(tokenBody('stale', 3600)),
          () => jsonResponse(tokenBody('fresh', 3600)),
        ],
        [CONTACTS_URL]: [
          () => jsonResponse({}, { status: 401 }),
          () => jsonResponse({ data: [] }),
        ],
      });
      const client = makeClient(fetchMock);

      await client.searchContacts({ companyName: 'ZoomInfo' });

      expect(callsTo(calls, OAUTH_URL)).toHaveLength(2);
      const retry = nthCall(callsTo(calls, CONTACTS_URL), 1);
      expect(headersOf(retry).Authorization).toBe('Bearer fresh');
    });
  });

  describe('pagination', () => {
    it('appends page[number] / page[size] as query params (not body)', async () => {
      const pagedUrl =
        SEARCH_URL + '?page%5Bnumber%5D=2&page%5Bsize%5D=50';
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t'))],
        [pagedUrl]: [() => jsonResponse({ data: [], meta: { page: { number: 2 } } })],
      });
      const client = makeClient(fetchMock);

      await client.searchCompanies({ companyName: 'Microsoft' }, { page: 2, pageSize: 50 });

      const search = nthCall(calls, 1);
      expect(search.url).toBe(pagedUrl);
      // Pagination must NOT leak into the request body.
      expect(JSON.parse(String(search.init.body))).toEqual({
        data: { type: 'CompanySearch', attributes: { companyName: 'Microsoft' } },
      });
    });

    it('omits the query string entirely when no paging is requested', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t'))],
        [SEARCH_URL]: [() => jsonResponse({ data: [] })],
      });
      const client = makeClient(fetchMock);

      await client.searchCompanies({ companyName: 'Microsoft' });

      expect(nthCall(calls, 1).url).toBe(SEARCH_URL);
    });

    it('ignores non-positive / non-integer paging values', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t'))],
        [CONTACTS_URL]: [() => jsonResponse({ data: [] })],
      });
      const client = makeClient(fetchMock);

      await client.searchContacts(
        { companyName: 'Acme' },
        { page: 0, pageSize: -5 },
      );

      expect(nthCall(calls, 1).url).toBe(CONTACTS_URL);
    });
  });

  describe('enrichContacts', () => {
    const ENRICH_URL = 'https://api.zoominfo.com/gtm/data/v1/contacts/enrich';

    it('posts ContactEnrich with matchPersonInput + outputFields', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t'))],
        [ENRICH_URL]: [
          () =>
            jsonResponse({
              data: [
                {
                  id: '1260398587',
                  type: 'Contact',
                  attributes: { email: 'henry.schuck@zoominfo.com' },
                  meta: { matchStatus: 'FULL_MATCH' },
                },
              ],
            }),
        ],
      });
      const client = makeClient(fetchMock);

      const result = await client.enrichContacts(
        [{ personId: 1260398587 }],
        ['firstName', 'email'],
      );

      expect((result.data as unknown[]).length).toBe(1);
      const enrich = nthCall(calls, 1);
      expect(enrich.url).toBe(ENRICH_URL);
      expect(headersOf(enrich)['Content-Type']).toBe('application/vnd.api+json');
      expect(JSON.parse(String(enrich.init.body))).toEqual({
        data: {
          type: 'ContactEnrich',
          attributes: {
            matchPersonInput: [{ personId: 1260398587 }],
            outputFields: ['firstName', 'email'],
          },
        },
      });
    });

    it('throws before any request when matches is empty', async () => {
      const { fetchMock, calls } = stubFetch({});
      const client = makeClient(fetchMock);

      await expect(client.enrichContacts([], ['email'])).rejects.toThrow(
        /at least one match input/,
      );
      expect(calls).toHaveLength(0);
    });

    it('throws before any request when outputFields is empty', async () => {
      const { fetchMock, calls } = stubFetch({});
      const client = makeClient(fetchMock);

      await expect(
        client.enrichContacts([{ personId: 1 }], []),
      ).rejects.toThrow(/at least one output field/);
      expect(calls).toHaveLength(0);
    });

    it('refreshes the token once on a 401 and retries enrich', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [
          () => jsonResponse(tokenBody('stale', 3600)),
          () => jsonResponse(tokenBody('fresh', 3600)),
        ],
        [ENRICH_URL]: [
          () => jsonResponse({}, { status: 401 }),
          () => jsonResponse({ data: [] }),
        ],
      });
      const client = makeClient(fetchMock);

      await client.enrichContacts([{ personId: 1 }], ['email']);

      expect(callsTo(calls, OAUTH_URL)).toHaveLength(2);
      const retry = nthCall(callsTo(calls, ENRICH_URL), 1);
      expect(headersOf(retry).Authorization).toBe('Bearer fresh');
    });
  });

  describe('token caching + refresh (OAuth refresh + token rotation)', () => {
    it('reuses the cached token across calls within its TTL — one mint', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('cached', 3600))],
        [SEARCH_URL]: [
          () => jsonResponse({ data: [] }),
          () => jsonResponse({ data: [] }),
        ],
      });
      const client = makeClient(fetchMock);

      await client.searchCompanies({ companyName: 'A' });
      await client.searchCompanies({ companyName: 'B' });

      expect(calls.filter((c) => c.url === OAUTH_URL)).toHaveLength(1);
      expect(calls.filter((c) => c.url === SEARCH_URL)).toHaveLength(2);
    });

    it('mints a fresh token once the cached one expires', async () => {
      let clock = 0;
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [
          () => jsonResponse(tokenBody('first', 60)), // expires at 60s − skew
          () => jsonResponse(tokenBody('second', 60)),
        ],
        [SEARCH_URL]: [
          () => jsonResponse({ data: [] }),
          () => jsonResponse({ data: [] }),
        ],
      });
      const client = new ZoomInfoClient({
        clientSecret: 'test-secret',
        httpFetch: fetchMock,
        tokenSkewMs: 0,
        now: () => clock,
      });

      await client.searchCompanies({ companyName: 'A' });
      clock = 61_000; // past the 60s lifetime
      await client.searchCompanies({ companyName: 'B' });

      expect(callsTo(calls, OAUTH_URL)).toHaveLength(2);
      const secondSearch = nthCall(callsTo(calls, SEARCH_URL), 1);
      expect(headersOf(secondSearch).Authorization).toBe('Bearer second');
    });

    it('falls back to the default TTL when expires_in is absent', async () => {
      let clock = 0;
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('no-expiry'))],
        [SEARCH_URL]: [
          () => jsonResponse({ data: [] }),
          () => jsonResponse({ data: [] }),
        ],
      });
      const client = new ZoomInfoClient({
        clientSecret: 'test-secret',
        httpFetch: fetchMock,
        tokenTtlMs: 60_000,
        tokenSkewMs: 0,
        now: () => clock,
      });

      await client.searchCompanies({ companyName: 'A' });
      clock = 30_000; // still inside the 60s default TTL
      await client.searchCompanies({ companyName: 'B' });

      expect(calls.filter((c) => c.url === OAUTH_URL)).toHaveLength(1);
    });

    it('single-flights concurrent first calls into one token mint', async () => {
      let resolveToken: (r: Response) => void = () => {};
      const tokenGate = new Promise<Response>((resolve) => {
        resolveToken = resolve;
      });
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [() => tokenGate],
        [SEARCH_URL]: [
          () => jsonResponse({ data: [] }),
          () => jsonResponse({ data: [] }),
        ],
      });
      const client = makeClient(fetchMock);

      const a = client.searchCompanies({ companyName: 'A' });
      const b = client.searchCompanies({ companyName: 'B' });
      resolveToken(jsonResponse(tokenBody('shared', 3600)));
      await Promise.all([a, b]);

      expect(calls.filter((c) => c.url === OAUTH_URL)).toHaveLength(1);
      expect(calls.filter((c) => c.url === SEARCH_URL)).toHaveLength(2);
    });

    it('refreshes the token once on a 401 mid-call and retries', async () => {
      const { fetchMock, calls } = stubFetch({
        [OAUTH_URL]: [
          () => jsonResponse(tokenBody('stale', 3600)),
          () => jsonResponse(tokenBody('fresh', 3600)),
        ],
        [SEARCH_URL]: [
          () => jsonResponse({ errors: [] }, { status: 401 }),
          () => jsonResponse({ data: [{ id: 'ok' }] }),
        ],
      });
      const client = makeClient(fetchMock);

      const result = await client.searchCompanies({ companyName: 'A' });

      expect(result).toEqual({ data: [{ id: 'ok' }] });
      expect(callsTo(calls, OAUTH_URL)).toHaveLength(2);
      const retry = nthCall(callsTo(calls, SEARCH_URL), 1);
      expect(headersOf(retry).Authorization).toBe('Bearer fresh');
    });

    it('throws ZoomInfoAuthError when a 401 persists after refresh', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [
          () => jsonResponse(tokenBody('a', 3600)),
          () => jsonResponse(tokenBody('b', 3600)),
        ],
        [SEARCH_URL]: [
          () => jsonResponse({}, { status: 401 }),
          () => jsonResponse({}, { status: 401 }),
        ],
      });
      const client = makeClient(fetchMock);

      await expect(client.searchCompanies({ companyName: 'A' })).rejects.toThrow(
        ZoomInfoAuthError,
      );
    });
  });

  describe('credential + error handling', () => {
    it('throws (without echoing the secret) when ZOOMINFO_CLIENT_SECRET is unset', async () => {
      const { fetchMock, calls } = stubFetch({});
      const client = new ZoomInfoClient({
        clientSecret: '',
        httpFetch: fetchMock,
      });

      await expect(
        client.searchCompanies({ companyName: 'A' }),
      ).rejects.toThrow(/ZOOMINFO_CLIENT_SECRET/);
      // No network call attempted when the secret is missing.
      expect(calls).toHaveLength(0);
    });

    it('maps a rejected client secret (400/401 from OAuth) to ZoomInfoAuthError', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse({ error: 'invalid_client' }, { status: 401 })],
      });
      const client = makeClient(fetchMock);

      await expect(client.searchCompanies({ companyName: 'A' })).rejects.toThrow(
        ZoomInfoAuthError,
      );
    });

    it('throws when the OAuth response carries no access_token', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse({ token_type: 'Bearer' })],
      });
      const client = makeClient(fetchMock);

      await expect(client.searchCompanies({ companyName: 'A' })).rejects.toThrow(
        /no access_token/,
      );
    });

    it('maps a 5xx from OAuth to ZoomInfoServerError', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse({}, { status: 503 })],
      });
      const client = makeClient(fetchMock);

      await expect(client.searchCompanies({ companyName: 'A' })).rejects.toThrow(
        ZoomInfoServerError,
      );
    });

    it('maps a 5xx from the search call to ZoomInfoServerError', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t', 3600))],
        [SEARCH_URL]: [() => jsonResponse({}, { status: 500 })],
      });
      const client = makeClient(fetchMock);

      await expect(client.searchCompanies({ companyName: 'A' })).rejects.toThrow(
        ZoomInfoServerError,
      );
    });

    it('surfaces a request timeout distinctly', async () => {
      const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        // Simulate an abort firing on the signal.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof fetch;
      const client = makeClient(fetchMock, { timeoutMs: 5 });

      await expect(client.searchCompanies({ companyName: 'A' })).rejects.toThrow(
        /timed out/,
      );
    });
  });

  describe('ping', () => {
    it('returns ok on a successful credential exchange', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse(tokenBody('t', 3600))],
      });
      const client = makeClient(fetchMock);

      expect(await client.ping()).toEqual({ ok: true });
    });

    it('returns the failure reason (never the secret) on a bad credential', async () => {
      const { fetchMock } = stubFetch({
        [OAUTH_URL]: [() => jsonResponse({}, { status: 401 })],
      });
      const client = makeClient(fetchMock);

      const result = await client.ping();
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('test-secret');
    });
  });
});
