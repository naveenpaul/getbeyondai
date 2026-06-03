import { describe, expect, it, vi } from 'vitest';
import type {
  DecryptedCredentials,
  NormalizedContact,
  SyncContactsParams,
} from '@getbeyond/shared';
import {
  SnovSourceAdapter,
  snovSourceAdapter,
  type SnovSourceConfig,
} from './snov.source';

const BASE = 'https://api.snov.io';
const CREDS: DecryptedCredentials = { clientId: 'id', clientSecret: 'sec' };

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Snov async `…/start` reply: 202 + the poll URL. */
function startResponse(resultUrl: string): Response {
  return jsonResponse(
    { data: [], meta: { task_hash: 'h' }, links: { result: resultUrl } },
    { status: 202 },
  );
}

/** A Snov result reply: 200 + terminal status + the data payload. */
function resultResponse(data: unknown, status = 'completed'): Response {
  return jsonResponse({ data, meta: { status } }, { status: 200 });
}

interface ProspectSpec {
  key: string;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  source_page?: string | null;
  /** When false, omit search_emails_start so the prospect has no email path. */
  withEmailPath?: boolean;
}

function prospect(spec: ProspectSpec): Record<string, unknown> {
  return {
    first_name: spec.first_name ?? 'Dana',
    last_name: spec.last_name ?? 'Reed',
    position: spec.position ?? 'VP Sales',
    source_page:
      spec.source_page === undefined
        ? `https://linkedin.com/in/${spec.key}`
        : spec.source_page,
    ...(spec.withEmailPath === false
      ? {}
      : {
          search_emails_start: `${BASE}/v2/domain-search/prospects/search-emails/start/${spec.key}`,
        }),
  };
}

interface World {
  token?: string;
  tokenStatus?: number;
  companyName?: string | null;
  /** page → prospect records */
  prospectsByPage?: Record<number, Record<string, unknown>[]>;
  /** prospect key → resolved email entries */
  emailsByKey?: Record<string, { email?: string | null; smtp_status?: string | null }[]>;
}

/** Route a Snov request flow against an in-memory world. Records every call. */
function buildFetch(world: World): {
  fetch: ReturnType<typeof vi.fn>;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (url.includes('/oauth/access_token')) {
      const st = world.tokenStatus ?? 200;
      if (st !== 200) return new Response('no', { status: st });
      return jsonResponse({ access_token: world.token ?? 'tok' });
    }
    if (url.includes('/search-emails/result/')) {
      const key = url.split('/search-emails/result/').pop()!;
      return resultResponse({ emails: world.emailsByKey?.[key] ?? [] });
    }
    if (url.includes('/search-emails/start/')) {
      const key = url.split('/search-emails/start/').pop()!;
      return startResponse(`${BASE}/v2/domain-search/prospects/search-emails/result/${key}`);
    }
    if (url.includes('/prospects/result/')) {
      const page = Number(url.match(/\/p(\d+)$/)?.[1] ?? '1');
      return resultResponse(world.prospectsByPage?.[page] ?? []);
    }
    if (url.includes('/prospects/start')) {
      const page = new URL(url).searchParams.get('page') ?? '1';
      return startResponse(`${BASE}/v2/domain-search/prospects/result/p${page}`);
    }
    if (url.includes('/domain-search/result/')) {
      return resultResponse({ company_name: world.companyName ?? 'Acme Inc' });
    }
    if (url.includes('/domain-search/start')) {
      return startResponse(`${BASE}/v2/domain-search/result/co`);
    }
    throw new Error(`unexpected URL in stub: ${method} ${url}`);
  });
  return { fetch, calls };
}

function adapterWith(fetchFn: typeof fetch): SnovSourceAdapter {
  return new SnovSourceAdapter({
    httpFetch: fetchFn,
    pollIntervalMs: 0,
    pollMaxTries: 5,
  });
}

function syncParams(
  config: SnovSourceConfig,
  overrides: Partial<SyncContactsParams<SnovSourceConfig>> = {},
): SyncContactsParams<SnovSourceConfig> {
  return {
    creds: CREDS,
    config,
    onVendorFailure: vi.fn(async () => {}),
    onVendorSuccess: vi.fn(),
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<NormalizedContact>,
): Promise<NormalizedContact[]> {
  const out: NormalizedContact[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('SnovSourceAdapter — identity', () => {
  it('declares kind=snov, authMode=byo_key', () => {
    const adapter = new SnovSourceAdapter();
    expect(adapter.kind).toBe('snov');
    expect(adapter.authMode).toBe('byo_key');
  });

  it('exports a ready-to-register singleton', () => {
    expect(snovSourceAdapter).toBeInstanceOf(SnovSourceAdapter);
  });
});

describe('SnovSourceAdapter — ping', () => {
  it('returns ok when the credentials exchange succeeds (no credit cost)', async () => {
    const { fetch, calls } = buildFetch({});
    const result = await adapterWith(fetch).ping(CREDS);
    expect(result).toEqual({ ok: true, scopes: [] });
    // Only the OAuth endpoint is hit — ping must not spend credits.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/oauth/access_token');
  });

  it('returns ok:false (no creds leaked) when the keys are rejected', async () => {
    const { fetch } = buildFetch({ tokenStatus: 401 });
    const result = await adapterWith(fetch).ping(CREDS);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('sec');
  });

  it('reports a 5xx auth server error to the breaker via ping result', async () => {
    const { fetch } = buildFetch({ tokenStatus: 503 });
    const result = await adapterWith(fetch).ping(CREDS);
    expect(result.ok).toBe(false);
  });
});

describe('SnovSourceAdapter — credentials validation', () => {
  it('throws when clientId is missing', async () => {
    const { fetch } = buildFetch({});
    const iter = adapterWith(fetch).syncContacts(
      syncParams({ domains: ['acme.com'] }, { creds: { clientSecret: 'x' } }),
    );
    await expect(collect(iter)).rejects.toThrow(/clientId/);
  });

  it('throws when clientSecret is missing', async () => {
    const { fetch } = buildFetch({});
    const iter = adapterWith(fetch).syncContacts(
      syncParams({ domains: ['acme.com'] }, { creds: { clientId: 'x' } }),
    );
    await expect(collect(iter)).rejects.toThrow(/clientSecret/);
  });
});

describe('SnovSourceAdapter — syncContacts happy path', () => {
  it('maps prospects + resolved emails to normalized contacts with company name', async () => {
    const { fetch } = buildFetch({
      companyName: 'Acme Inc',
      prospectsByPage: { 1: [prospect({ key: 'a' }), prospect({ key: 'b' })] },
      emailsByKey: {
        a: [{ email: 'a@acme.com', smtp_status: 'valid' }],
        b: [{ email: 'b@acme.com', smtp_status: 'unknown' }],
      },
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(syncParams({ domains: ['acme.com'] })),
    );
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      emailRaw: 'a@acme.com',
      externalId: 'https://linkedin.com/in/a',
      externalUrl: 'https://linkedin.com/in/a',
      firstName: 'Dana',
      lastName: 'Reed',
      title: 'VP Sales',
      company: 'Acme Inc',
      linkedinUrl: 'https://linkedin.com/in/a',
    });
  });

  it('imports ALL email statuses, labelling smtp_status in rawPayload (no filtering)', async () => {
    const { fetch } = buildFetch({
      prospectsByPage: { 1: [prospect({ key: 'a' }), prospect({ key: 'b' })] },
      emailsByKey: {
        a: [{ email: 'a@acme.com', smtp_status: 'valid' }],
        b: [{ email: 'b@acme.com', smtp_status: 'unknown' }],
      },
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(syncParams({ domains: ['acme.com'] })),
    );
    const statuses = contacts.map(
      (c) => (c.rawPayload as { email: { smtp_status: string } }).email.smtp_status,
    );
    expect(statuses).toEqual(['valid', 'unknown']);
  });

  it('maps smtp_status to the normalized emailVerification signal', async () => {
    const { fetch } = buildFetch({
      prospectsByPage: {
        1: [prospect({ key: 'a' }), prospect({ key: 'b' }), prospect({ key: 'c' })],
      },
      emailsByKey: {
        a: [{ email: 'a@acme.com', smtp_status: 'valid' }],
        b: [{ email: 'b@acme.com', smtp_status: 'unknown' }],
        c: [{ email: 'c@acme.com', smtp_status: 'not_valid' }],
      },
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(syncParams({ domains: ['acme.com'] })),
    );
    expect(contacts.map((c) => c.emailVerification)).toEqual([
      'verified',
      'unknown',
      'unverified',
    ]);
  });

  it('falls back to the email as externalId when there is no LinkedIn URL', async () => {
    const { fetch } = buildFetch({
      prospectsByPage: { 1: [prospect({ key: 'a', source_page: null })] },
      emailsByKey: { a: [{ email: 'a@acme.com', smtp_status: 'valid' }] },
    });
    const [contact] = await collect(
      adapterWith(fetch).syncContacts(syncParams({ domains: ['acme.com'] })),
    );
    expect(contact!.externalId).toBe('a@acme.com');
    expect(contact!.externalUrl).toBeUndefined();
    expect(contact!.linkedinUrl).toBeNull();
  });

  it('skips prospects with no resolvable email', async () => {
    const { fetch } = buildFetch({
      prospectsByPage: {
        1: [
          prospect({ key: 'a' }),
          prospect({ key: 'b', withEmailPath: false }), // no email start path
          prospect({ key: 'c' }),
        ],
      },
      emailsByKey: {
        a: [{ email: 'a@acme.com', smtp_status: 'valid' }],
        c: [], // email lookup returns nothing
      },
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(syncParams({ domains: ['acme.com'] })),
    );
    expect(contacts.map((c) => c.emailRaw)).toEqual(['a@acme.com']);
  });
});

describe('SnovSourceAdapter — config behaviour', () => {
  it('passes positions[] as repeated query params', async () => {
    const { fetch, calls } = buildFetch({
      prospectsByPage: { 1: [prospect({ key: 'a' })] },
      emailsByKey: { a: [{ email: 'a@acme.com', smtp_status: 'valid' }] },
    });
    await collect(
      adapterWith(fetch).syncContacts(
        syncParams({ domains: ['acme.com'], positions: ['VP Sales', 'Head of Sales'] }),
      ),
    );
    const prospectStart = calls.find((c) => c.url.includes('/prospects/start'))!;
    expect(prospectStart.url).toContain('positions%5B%5D=VP+Sales');
    expect(prospectStart.url).toContain('positions%5B%5D=Head+of+Sales');
  });

  it('honours maxContactsPerDomain', async () => {
    const { fetch } = buildFetch({
      prospectsByPage: {
        1: [prospect({ key: 'a' }), prospect({ key: 'b' }), prospect({ key: 'c' })],
      },
      emailsByKey: {
        a: [{ email: 'a@acme.com', smtp_status: 'valid' }],
        b: [{ email: 'b@acme.com', smtp_status: 'valid' }],
        c: [{ email: 'c@acme.com', smtp_status: 'valid' }],
      },
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(
        syncParams({ domains: ['acme.com'], maxContactsPerDomain: 2 }),
      ),
    );
    expect(contacts).toHaveLength(2);
  });

  it('sources from multiple domains in order', async () => {
    // Both domains share the stub; assert the company-info call fired per domain.
    const { fetch, calls } = buildFetch({
      prospectsByPage: { 1: [prospect({ key: 'a' })] },
      emailsByKey: { a: [{ email: 'a@acme.com', smtp_status: 'valid' }] },
    });
    await collect(
      adapterWith(fetch).syncContacts(
        syncParams({ domains: ['acme.com', 'beta.io'] }),
      ),
    );
    const companyStarts = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/v2/domain-search/start?domain=acme.com'),
    );
    const betaStarts = calls.filter((c) =>
      c.url.endsWith('/v2/domain-search/start?domain=beta.io'),
    );
    expect(companyStarts).toHaveLength(1);
    expect(betaStarts).toHaveLength(1);
  });

  it('normalizes messy domains and skips invalid ones', async () => {
    const { fetch, calls } = buildFetch({
      prospectsByPage: { 1: [prospect({ key: 'a' })] },
      emailsByKey: { a: [{ email: 'a@acme.com', smtp_status: 'valid' }] },
    });
    await collect(
      adapterWith(fetch).syncContacts(
        syncParams({ domains: ['https://www.Acme.com/team', 'not-a-domain', '  '] }),
      ),
    );
    // Only the one valid domain triggers a company-info start, normalized.
    const starts = calls.filter((c) =>
      c.url.includes('/v2/domain-search/start?domain='),
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]!.url).toContain('domain=acme.com');
  });
});

describe('SnovSourceAdapter — pagination', () => {
  it('advances to the next page on a full page and stops on a short one', async () => {
    const fullPage = Array.from({ length: 20 }, (_, i) => prospect({ key: `p${i}` }));
    const emailsByKey: World['emailsByKey'] = {};
    for (let i = 0; i < 20; i++) {
      emailsByKey[`p${i}`] = [{ email: `p${i}@acme.com`, smtp_status: 'valid' }];
    }
    emailsByKey['tail'] = [{ email: 'tail@acme.com', smtp_status: 'valid' }];
    const { fetch, calls } = buildFetch({
      prospectsByPage: { 1: fullPage, 2: [prospect({ key: 'tail' })] },
      emailsByKey,
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(syncParams({ domains: ['acme.com'] })),
    );
    expect(contacts).toHaveLength(21);
    // Page 2 was fetched; page 3 was not (page 2 was short).
    expect(calls.some((c) => c.url.includes('/prospects/result/p2'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/prospects/result/p3'))).toBe(false);
  });

  it('resumes from a cursor (domainIndex:page)', async () => {
    const { fetch, calls } = buildFetch({
      prospectsByPage: { 2: [prospect({ key: 'a' })] },
      emailsByKey: { a: [{ email: 'a@acme.com', smtp_status: 'valid' }] },
    });
    const contacts = await collect(
      adapterWith(fetch).syncContacts(
        syncParams({ domains: ['acme.com'] }, { cursor: '0:2' }),
      ),
    );
    expect(contacts).toHaveLength(1);
    // It started at page 2 — page 1 was never requested.
    expect(calls.some((c) => c.url.includes('/prospects/result/p1'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/prospects/result/p2'))).toBe(true);
  });
});

describe('SnovSourceAdapter — polling', () => {
  it('keeps polling while a result is in_progress', async () => {
    let prospectPolls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/access_token')) return jsonResponse({ access_token: 't' });
      if (url.includes('/domain-search/start') && !url.includes('prospects'))
        return startResponse(`${BASE}/v2/domain-search/result/co`);
      if (url.includes('/domain-search/result/'))
        return resultResponse({ company_name: 'Acme' });
      if (url.includes('/prospects/start'))
        return startResponse(`${BASE}/v2/domain-search/prospects/result/p1`);
      if (url.includes('/prospects/result/')) {
        prospectPolls += 1;
        // First poll: still processing (202). Second poll: done.
        if (prospectPolls === 1) return jsonResponse({ data: [], meta: { status: 'in_progress' } }, { status: 202 });
        return resultResponse([prospect({ key: 'a' })]);
      }
      if (url.includes('/search-emails/start/'))
        return startResponse(`${BASE}/v2/domain-search/prospects/search-emails/result/a`);
      if (url.includes('/search-emails/result/'))
        return resultResponse({ emails: [{ email: 'a@acme.com', smtp_status: 'valid' }] });
      throw new Error(`unexpected ${url}`);
    });
    const contacts = await collect(
      adapterWith(fetch as unknown as typeof globalThis.fetch).syncContacts(
        syncParams({ domains: ['acme.com'] }),
      ),
    );
    expect(contacts).toHaveLength(1);
    expect(prospectPolls).toBeGreaterThanOrEqual(2);
  });

  it('throws when a task never reaches a terminal status', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oauth/access_token')) return jsonResponse({ access_token: 't' });
      if (url.includes('/domain-search/start') && !url.includes('prospects'))
        return startResponse(`${BASE}/v2/domain-search/result/co`);
      // Result endpoint is forever 202/in_progress.
      return jsonResponse({ data: [], meta: { status: 'in_progress' } }, { status: 202 });
    });
    const iter = adapterWith(fetch as unknown as typeof globalThis.fetch).syncContacts(
      syncParams({ domains: ['acme.com'] }),
    );
    await expect(collect(iter)).rejects.toThrow(/did not complete/);
  });
});

describe('SnovSourceAdapter — breaker + auth retry', () => {
  it('reports vendor success and never failure on a clean run', async () => {
    const { fetch } = buildFetch({
      prospectsByPage: { 1: [prospect({ key: 'a' })] },
      emailsByKey: { a: [{ email: 'a@acme.com', smtp_status: 'valid' }] },
    });
    const onVendorSuccess = vi.fn();
    const onVendorFailure = vi.fn(async () => {});
    await collect(
      adapterWith(fetch).syncContacts(
        syncParams({ domains: ['acme.com'] }, { onVendorSuccess, onVendorFailure }),
      ),
    );
    expect(onVendorSuccess).toHaveBeenCalled();
    expect(onVendorFailure).not.toHaveBeenCalled();
  });

  it('trips the breaker with server_5xx on a 5xx', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oauth/access_token')) return jsonResponse({ access_token: 't' });
      return new Response('boom', { status: 502 });
    });
    const onVendorFailure = vi.fn(async () => {});
    const iter = adapterWith(fetch as unknown as typeof globalThis.fetch).syncContacts(
      syncParams({ domains: ['acme.com'] }, { onVendorFailure }),
    );
    await expect(collect(iter)).rejects.toThrow(/server error/i);
    expect(onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('refreshes the token once on a 401 and retries successfully', async () => {
    let firstProspectCall = true;
    let tokenExchanges = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oauth/access_token')) {
        tokenExchanges += 1;
        return jsonResponse({ access_token: `t${tokenExchanges}` });
      }
      if (url.includes('/domain-search/start') && !url.includes('prospects'))
        return startResponse(`${BASE}/v2/domain-search/result/co`);
      if (url.includes('/domain-search/result/'))
        return resultResponse({ company_name: 'Acme' });
      if (url.includes('/prospects/start')) {
        if (firstProspectCall) {
          firstProspectCall = false;
          return new Response('expired', { status: 401 });
        }
        return startResponse(`${BASE}/v2/domain-search/prospects/result/p1`);
      }
      if (url.includes('/prospects/result/'))
        return resultResponse([prospect({ key: 'a' })]);
      if (url.includes('/search-emails/start/'))
        return startResponse(`${BASE}/v2/domain-search/prospects/search-emails/result/a`);
      if (url.includes('/search-emails/result/'))
        return resultResponse({ emails: [{ email: 'a@acme.com', smtp_status: 'valid' }] });
      throw new Error(`unexpected ${url}`);
    });
    const contacts = await collect(
      adapterWith(fetch as unknown as typeof globalThis.fetch).syncContacts(
        syncParams({ domains: ['acme.com'] }),
      ),
    );
    expect(contacts).toHaveLength(1);
    expect(tokenExchanges).toBeGreaterThanOrEqual(2); // initial + one refresh
  });

  it('signals auth_invalid when a 401 persists after a refresh', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oauth/access_token')) return jsonResponse({ access_token: 't' });
      if (url.includes('/domain-search/start') && !url.includes('prospects'))
        return new Response('expired', { status: 401 });
      return new Response('expired', { status: 401 });
    });
    const onVendorFailure = vi.fn(async () => {});
    const iter = adapterWith(fetch as unknown as typeof globalThis.fetch).syncContacts(
      syncParams({ domains: ['acme.com'] }, { onVendorFailure }),
    );
    await expect(collect(iter)).rejects.toThrow(/after a token refresh/);
    expect(onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });
});
