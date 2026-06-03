import { describe, expect, it, vi } from 'vitest';
import type {
  DecryptedCredentials,
  NormalizedContact,
  SyncContactsParams,
} from '@getbeyond/shared';
import {
  ApolloSourceAdapter,
  apolloSourceAdapter,
  type ApolloOrganization,
  type ApolloOrgSearchParams,
  type ApolloSourceConfig,
} from './apollo.source';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function apolloPerson(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    first_name: 'Dana',
    last_name: 'Reed',
    title: 'VP Revenue',
    linkedin_url: 'https://linkedin.com/in/danareed',
    email: 'dana@acme.com',
    email_status: 'verified',
    organization: { name: 'Acme Inc' },
    ...overrides,
  };
}

const CREDS: DecryptedCredentials = { apiKey: 'k' };

/** Build syncContacts params with spy hooks. */
function syncParams(
  overrides: Partial<SyncContactsParams<ApolloSourceConfig>> = {},
): SyncContactsParams<ApolloSourceConfig> {
  return {
    creds: CREDS,
    config: { search: {} },
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

describe('ApolloSourceAdapter — identity', () => {
  it('declares kind=apollo, authMode=byo_key', () => {
    const adapter = new ApolloSourceAdapter();
    expect(adapter.kind).toBe('apollo');
    expect(adapter.authMode).toBe('byo_key');
  });

  it('exports a ready-to-register singleton', () => {
    expect(apolloSourceAdapter).toBeInstanceOf(ApolloSourceAdapter);
  });
});

describe('ApolloSourceAdapter — ping', () => {
  it('returns ok on a healthy key', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({ ok: true }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const result = await adapter.ping(CREDS);
    expect(result).toEqual({ ok: true, scopes: [] });
    const [url, init] = httpFetch.mock.calls[0]!;
    expect(url).toBe('https://api.apollo.io/v1/auth/health');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ 'X-Api-Key': 'k' });
  });

  it('returns ok=false with an error on a rejected key', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({}, { status: 401 }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const result = await adapter.ping(CREDS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns ok=false on a transport failure without leaking the key', async () => {
    const httpFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const result = await adapter.ping({ apiKey: 'super-secret-key-value' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(JSON.stringify(result)).not.toContain('super-secret-key-value');
  });

  it('reports a timeout (AbortError) distinctly', async () => {
    const httpFetch = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const adapter = new ApolloSourceAdapter({ httpFetch, timeoutMs: 5 });
    const result = await adapter.ping(CREDS);
    expect(result.error).toContain('timed out');
  });

  it('tolerates a non-Error transport rejection', async () => {
    const httpFetch = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure';
    });
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const result = await adapter.ping(CREDS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('string failure');
  });
});

describe('ApolloSourceAdapter — syncContacts mapping', () => {
  it('maps an Apollo person to a NormalizedContact with email_status in rawPayload', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({ people: [apolloPerson()], pagination: { total_pages: 1 } }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const [contact] = await collect(adapter.syncContacts(syncParams()));
    expect(contact).toMatchObject({
      emailRaw: 'dana@acme.com',
      externalId: 'p1',
      externalUrl: 'https://app.apollo.io/#/people/p1',
      firstName: 'Dana',
      lastName: 'Reed',
      title: 'VP Revenue',
      company: 'Acme Inc',
      linkedinUrl: 'https://linkedin.com/in/danareed',
    });
    expect((contact!.rawPayload as { email_status?: string }).email_status).toBe(
      'verified',
    );
  });

  it('translates search criteria into the People Search body', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({ people: [], pagination: { total_pages: 1 } }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    await collect(
      adapter.syncContacts(
        syncParams({
          config: {
            search: {
              titles: ['VP Sales'],
              seniorities: ['vp'],
              industries: ['fintech'],
              keywords: ['payments'],
              locations: ['NYC'],
              domains: ['acme.com', 'globex.com'],
              companyHeadcount: { min: 11, max: 50 },
            },
          },
        }),
      ),
    );
    const body = JSON.parse(httpFetch.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      person_titles: ['VP Sales'],
      person_seniorities: ['vp'],
      person_locations: ['NYC'],
      q_organization_domains: 'acme.com\nglobex.com',
      q_keywords: 'payments fintech',
      organization_num_employees_ranges: ['11,50'],
      page: 1,
      per_page: 100,
    });
  });

  it('skips people with no unlocked email or no id', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({
          people: [
            apolloPerson({ id: 'ok', email: 'real@acme.com' }),
            apolloPerson({ id: 'locked', email: 'email_not_unlocked@domain.com' }),
            apolloPerson({ id: null, email: 'noid@acme.com' }),
            apolloPerson({ id: 'noemail', email: null }),
          ],
          pagination: { total_pages: 1 },
        }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const contacts = await collect(adapter.syncContacts(syncParams()));
    expect(contacts.map((c) => c.externalId)).toEqual(['ok']);
  });

  it('nulls blank optional fields and a missing organization', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({
          people: [
            {
              id: 'p1',
              email: 'x@acme.com',
              first_name: '  ',
              last_name: '',
              title: null,
              linkedin_url: undefined,
              organization: null,
            },
          ],
          pagination: { total_pages: 1 },
        }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const [contact] = await collect(adapter.syncContacts(syncParams()));
    expect(contact).toMatchObject({
      firstName: null,
      lastName: null,
      title: null,
      company: null,
      linkedinUrl: null,
    });
  });
});

describe('ApolloSourceAdapter — pagination', () => {
  it('walks pages until total_pages and stops', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) => {
        const page = JSON.parse(init!.body as string).page as number;
        return jsonResponse({
          people: [apolloPerson({ id: `p${page}`, email: `p${page}@acme.com` })],
          pagination: { page, total_pages: 3 },
        });
      },
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const contacts = await collect(adapter.syncContacts(syncParams()));
    expect(contacts.map((c) => c.externalId)).toEqual(['p1', 'p2', 'p3']);
    expect(httpFetch).toHaveBeenCalledTimes(3);
  });

  it('stops when a page returns zero people even without total_pages', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) => {
        const page = JSON.parse(init!.body as string).page as number;
        return jsonResponse(
          page === 1
            ? { people: [apolloPerson({ id: 'p1' })] }
            : { people: [] },
        );
      },
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const contacts = await collect(adapter.syncContacts(syncParams()));
    expect(contacts).toHaveLength(1);
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it('resumes from the cursor page', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) => {
        const page = JSON.parse(init!.body as string).page as number;
        return jsonResponse({
          people: [apolloPerson({ id: `p${page}`, email: `p${page}@acme.com` })],
          pagination: { page, total_pages: 5 },
        });
      },
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const contacts = await collect(
      adapter.syncContacts(syncParams({ cursor: '4' })),
    );
    expect(contacts.map((c) => c.externalId)).toEqual(['p4', 'p5']);
  });

  it('honors maxContacts across pages', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) => {
        const page = JSON.parse(init!.body as string).page as number;
        return jsonResponse({
          people: [
            apolloPerson({ id: `p${page}a`, email: `${page}a@acme.com` }),
            apolloPerson({ id: `p${page}b`, email: `${page}b@acme.com` }),
          ],
          pagination: { page, total_pages: 10 },
        });
      },
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const contacts = await collect(
      adapter.syncContacts(
        syncParams({ config: { search: {}, maxContacts: 3 } }),
      ),
    );
    expect(contacts).toHaveLength(3);
  });
});

describe('ApolloSourceAdapter — circuit breaker + auth (REGRESSION-IF-BROKEN: Apollo 401 mid-sync)', () => {
  it('signals auth_invalid and throws on a 401 mid-sync', async () => {
    const onVendorFailure = vi.fn(async () => {});
    let call = 0;
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) => {
        call += 1;
        return call === 1
          ? jsonResponse({
              people: [apolloPerson({ id: 'p1' })],
              pagination: { page: 1, total_pages: 5 },
            })
          : jsonResponse({}, { status: 401 });
      },
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const params = syncParams({ onVendorFailure });

    const err = await collect(adapter.syncContacts(params)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('rejected the API key');
    expect(onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });

  it('treats 403 as an auth failure too', async () => {
    const onVendorFailure = vi.fn(async () => {});
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({}, { status: 403 }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    await collect(
      adapter.syncContacts(syncParams({ onVendorFailure })),
    ).catch(() => {});
    expect(onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });

  it('signals server_5xx and throws on a 500', async () => {
    const onVendorFailure = vi.fn(async () => {});
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({}, { status: 503 }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const err = await collect(
      adapter.syncContacts(syncParams({ onVendorFailure })),
    ).catch((e) => e);
    expect((err as Error).message).toContain('server error');
    expect(onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('signals server_5xx and rethrows on a transport failure', async () => {
    const onVendorFailure = vi.fn(async () => {});
    const httpFetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const err = await collect(
      adapter.syncContacts(syncParams({ onVendorFailure })),
    ).catch((e) => e);
    expect((err as Error).message).toContain('socket hang up');
    expect(onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('calls onVendorSuccess after each successful page', async () => {
    const onVendorSuccess = vi.fn();
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) => {
        const page = JSON.parse(init!.body as string).page as number;
        return jsonResponse({
          people: [apolloPerson({ id: `p${page}` })],
          pagination: { page, total_pages: 2 },
        });
      },
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    await collect(adapter.syncContacts(syncParams({ onVendorSuccess })));
    expect(onVendorSuccess).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-5xx, non-auth error status', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({ error: 'bad request' }, { status: 422 }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const err = await collect(adapter.syncContacts(syncParams())).catch(
      (e) => e,
    );
    expect((err as Error).message).toContain('Apollo HTTP 422');
  });

  it('throws on a non-JSON body', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        new Response('<html>', { status: 200 }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    await expect(
      collect(adapter.syncContacts(syncParams())),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe('ApolloSourceAdapter — credentials', () => {
  it('throws when the apiKey is missing', async () => {
    const adapter = new ApolloSourceAdapter({
      httpFetch: vi.fn(async () => jsonResponse({})),
    });
    await expect(adapter.ping({} as DecryptedCredentials)).rejects.toThrow(
      /apiKey/,
    );
  });

  it('throws when the apiKey is blank', async () => {
    const adapter = new ApolloSourceAdapter({
      httpFetch: vi.fn(async () => jsonResponse({})),
    });
    await expect(
      collect(adapter.syncContacts(syncParams({ creds: { apiKey: '  ' } }))),
    ).rejects.toThrow(/apiKey/);
  });
});

// ─── Organization Search (company discovery) ────────────────────────────────

function apolloOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    name: 'Acme Inc',
    primary_domain: 'acme.com',
    website_url: 'https://www.acme.com',
    linkedin_url: 'https://linkedin.com/company/acme',
    estimated_num_employees: 42,
    latest_funding_stage: 'Seed',
    ...overrides,
  };
}

function orgParams(
  overrides: Partial<ApolloOrgSearchParams> = {},
): ApolloOrgSearchParams {
  return {
    creds: CREDS,
    config: { search: {} },
    onVendorFailure: vi.fn(async () => {}),
    onVendorSuccess: vi.fn(),
    ...overrides,
  };
}

async function collectOrgs(
  iter: AsyncIterable<ApolloOrganization>,
): Promise<ApolloOrganization[]> {
  const out: ApolloOrganization[] = [];
  for await (const o of iter) out.push(o);
  return out;
}

describe('ApolloSourceAdapter — searchOrganizations mapping', () => {
  it('maps an Apollo organization to the normalized company shape', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({ organizations: [apolloOrg()], pagination: { total_pages: 1 } }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const [org] = await collectOrgs(adapter.searchOrganizations(orgParams()));
    expect(org).toMatchObject({
      externalId: 'o1',
      name: 'Acme Inc',
      domain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/company/acme',
      employeeCount: 42,
      fundingStage: 'Seed',
    });
    expect(org!.raw).toMatchObject({ id: 'o1' });
  });

  it('derives the domain from website_url when primary_domain is absent', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({
        organizations: [
          apolloOrg({ primary_domain: null, domain: null, website_url: 'https://www.beta.io/x' }),
        ],
        pagination: { total_pages: 1 },
      }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const [org] = await collectOrgs(adapter.searchOrganizations(orgParams()));
    expect(org!.domain).toBe('beta.io');
  });

  it('translates ICP criteria into the Organization Search body', async () => {
    const httpFetch = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse({ organizations: [], pagination: { total_pages: 1 } }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    await collectOrgs(
      adapter.searchOrganizations(
        orgParams({
          config: {
            search: {
              keywords: ['devtools'],
              industries: ['software'],
              fundingStages: ['series_a'],
              locations: ['United States'],
              companyHeadcount: { min: 11, max: 50 },
            },
          },
        }),
      ),
    );
    expect(String(httpFetch.mock.calls[0]![0])).toContain(
      '/v1/mixed_companies/search',
    );
    const body = JSON.parse(httpFetch.mock.calls[0]![1]!.body as string);
    expect(body.q_organization_keyword_tags).toEqual([
      'devtools',
      'software',
      'series a',
    ]);
    expect(body.organization_locations).toEqual(['United States']);
    expect(body.organization_num_employees_ranges).toEqual(['11,50']);
  });

  it('skips organizations with no name', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({
        organizations: [apolloOrg({ name: '  ' }), apolloOrg({ id: 'o2', name: 'Beta' })],
        pagination: { total_pages: 1 },
      }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const orgs = await collectOrgs(adapter.searchOrganizations(orgParams()));
    expect(orgs.map((o) => o.name)).toEqual(['Beta']);
  });

  it('accepts the `accounts` key as a fallback for `organizations`', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({ accounts: [apolloOrg()], pagination: { total_pages: 1 } }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const orgs = await collectOrgs(adapter.searchOrganizations(orgParams()));
    expect(orgs).toHaveLength(1);
  });
});

describe('ApolloSourceAdapter — searchOrganizations pagination + breaker', () => {
  it('walks pages until total_pages and honors maxOrgs', async () => {
    const page1 = jsonResponse({
      organizations: [apolloOrg({ id: 'o1' }), apolloOrg({ id: 'o2' })],
      pagination: { total_pages: 5 },
    });
    const httpFetch = vi.fn(async () => page1);
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const orgs = await collectOrgs(
      adapter.searchOrganizations(orgParams({ config: { search: {}, maxOrgs: 2 } })),
    );
    expect(orgs).toHaveLength(2);
    // maxOrgs hit on the first page → only one request issued.
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('signals auth_invalid and throws on a 401', async () => {
    const httpFetch = vi.fn(async () => jsonResponse({ error: 'nope' }, { status: 401 }));
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const params = orgParams();
    await expect(
      collectOrgs(adapter.searchOrganizations(params)),
    ).rejects.toThrow(/rejected the API key/);
    expect(params.onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });

  it('signals server_5xx on a 500', async () => {
    const httpFetch = vi.fn(async () => jsonResponse({}, { status: 500 }));
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const params = orgParams();
    await expect(
      collectOrgs(adapter.searchOrganizations(params)),
    ).rejects.toThrow(/server error/);
    expect(params.onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('calls onVendorSuccess after a successful page', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({ organizations: [apolloOrg()], pagination: { total_pages: 1 } }),
    );
    const adapter = new ApolloSourceAdapter({ httpFetch });
    const params = orgParams();
    await collectOrgs(adapter.searchOrganizations(params));
    expect(params.onVendorSuccess).toHaveBeenCalled();
  });
});
