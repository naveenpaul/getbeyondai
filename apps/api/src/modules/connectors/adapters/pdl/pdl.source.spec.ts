import { describe, expect, it, vi } from 'vitest';
import type { DecryptedCredentials } from '@getbeyond/shared';
import {
  PdlSourceAdapter,
  pdlSourceAdapter,
  type PdlCompanyEnrichParams,
} from './pdl.source';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A typed fetch stub: params are declared so `.mock.calls[i]` is indexable under tsc. */
function fetchReturning(response: () => Response) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => response(),
  );
}

/** A PDL company-enrich 200 body. */
function pdlCompany(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    name: 'acme inc',
    website: 'www.acme.com',
    linkedin_url: 'linkedin.com/company/acme',
    employee_count: 42,
    industry: 'computer software',
    location: { name: 'san francisco, california, united states' },
    likelihood: 10,
    ...overrides,
  };
}

const CREDS: DecryptedCredentials = { apiKey: 'k' };

/** Build enrichCompany params with spy hooks. */
function enrichParams(
  overrides: Partial<PdlCompanyEnrichParams> = {},
): PdlCompanyEnrichParams {
  return {
    creds: CREDS,
    name: 'Acme Inc',
    domain: null,
    onVendorFailure: vi.fn(async () => {}),
    onVendorSuccess: vi.fn(),
    ...overrides,
  };
}

describe('PdlSourceAdapter — identity', () => {
  it('declares kind=pdl, authMode=byo_key', () => {
    const adapter = new PdlSourceAdapter();
    expect(adapter.kind).toBe('pdl');
    expect(adapter.authMode).toBe('byo_key');
  });

  it('exports a ready-to-register singleton', () => {
    expect(pdlSourceAdapter).toBeInstanceOf(PdlSourceAdapter);
  });
});

describe('PdlSourceAdapter — ping', () => {
  it('returns ok when the sentinel lookup 404s (valid key, no match, no credit)', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ status: 404 }, { status: 404 }));
    const adapter = new PdlSourceAdapter({ httpFetch });
    const result = await adapter.ping(CREDS);
    expect(result.ok).toBe(true);
    // The sentinel forces a guaranteed-miss + max likelihood (free 404).
    const url = String(httpFetch.mock.calls[0]?.[0]);
    expect(url).toContain('min_likelihood=10');
    expect(url).toContain('__getbeyond_pdl_ping__');
  });

  it('returns ok on a 200 as well', async () => {
    const httpFetch = fetchReturning(() => jsonResponse(pdlCompany()));
    const adapter = new PdlSourceAdapter({ httpFetch });
    expect((await adapter.ping(CREDS)).ok).toBe(true);
  });

  it('returns not-ok with a reason on a rejected key (401)', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ error: 'nope' }, { status: 401 }));
    const adapter = new PdlSourceAdapter({ httpFetch });
    const result = await adapter.ping(CREDS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns not-ok (never throws) on a transport error', async () => {
    const httpFetch = vi.fn(async () => {
      throw new Error('econnreset');
    });
    const adapter = new PdlSourceAdapter({ httpFetch });
    const result = await adapter.ping(CREDS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('econnreset');
  });

  it('rejects credentials with no apiKey', async () => {
    const adapter = new PdlSourceAdapter({ httpFetch: vi.fn() });
    const result = await adapter.ping({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('apiKey');
  });
});

describe('PdlSourceAdapter — enrichCompany', () => {
  it('maps a 200 company to the normalized record (domain/linkedin/headcount/industry/location)', async () => {
    const httpFetch = fetchReturning(() => jsonResponse(pdlCompany()));
    const adapter = new PdlSourceAdapter({ httpFetch });
    const params = enrichParams();
    const record = await adapter.enrichCompany(params);
    expect(record).toEqual({
      domain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/company/acme',
      employeeCount: 42,
      industry: 'computer software',
      location: 'san francisco, california, united states',
      raw: pdlCompany(),
    });
    expect(params.onVendorSuccess).toHaveBeenCalledTimes(1);
    expect(params.onVendorFailure).not.toHaveBeenCalled();
  });

  it('passes name + min_likelihood, and website when a domain is known', async () => {
    const httpFetch = fetchReturning(() => jsonResponse(pdlCompany()));
    const adapter = new PdlSourceAdapter({ httpFetch, minLikelihood: 6 });
    await adapter.enrichCompany(enrichParams({ name: 'Acme Inc', domain: 'acme.com' }));
    const url = String(httpFetch.mock.calls[0]?.[0]);
    expect(url).toContain('/v5/company/enrich');
    expect(url).toContain('name=Acme+Inc');
    expect(url).toContain('min_likelihood=6');
    expect(url).toContain('website=acme.com');
  });

  it('omits website when no domain is known', async () => {
    const httpFetch = fetchReturning(() => jsonResponse(pdlCompany()));
    const adapter = new PdlSourceAdapter({ httpFetch });
    await adapter.enrichCompany(enrichParams({ domain: null }));
    expect(String(httpFetch.mock.calls[0]?.[0])).not.toContain('website=');
  });

  it('sends the key in the X-Api-Key header', async () => {
    const httpFetch = fetchReturning(() => jsonResponse(pdlCompany()));
    const adapter = new PdlSourceAdapter({ httpFetch });
    await adapter.enrichCompany(enrichParams({ creds: { apiKey: 'secret-key' } }));
    const init = httpFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('secret-key');
  });

  it('returns null on a 404 no-match and clears the breaker window', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ status: 404 }, { status: 404 }));
    const adapter = new PdlSourceAdapter({ httpFetch });
    const params = enrichParams();
    const record = await adapter.enrichCompany(params);
    expect(record).toBeNull();
    expect(params.onVendorSuccess).toHaveBeenCalledTimes(1);
    expect(params.onVendorFailure).not.toHaveBeenCalled();
  });

  it('signals auth_invalid and throws on a rejected key (401)', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ error: 'nope' }, { status: 401 }));
    const adapter = new PdlSourceAdapter({ httpFetch });
    const params = enrichParams();
    await expect(adapter.enrichCompany(params)).rejects.toThrow(/401/);
    expect(params.onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });

  it('signals server_5xx and throws on a 503', async () => {
    const httpFetch = fetchReturning(() => jsonResponse({ error: 'down' }, { status: 503 }));
    const adapter = new PdlSourceAdapter({ httpFetch });
    const params = enrichParams();
    await expect(adapter.enrichCompany(params)).rejects.toThrow(/503/);
    expect(params.onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('feeds the breaker a 5xx and throws on a transport failure', async () => {
    const httpFetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const adapter = new PdlSourceAdapter({ httpFetch });
    const params = enrichParams();
    await expect(adapter.enrichCompany(params)).rejects.toThrow(/PDL request failed/);
    expect(params.onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('throws on a generic non-ok status (e.g. 429 rate limit) without tripping the breaker', async () => {
    const httpFetch = fetchReturning(() =>
      jsonResponse({ error: 'rate limited' }, { status: 429 }),
    );
    const adapter = new PdlSourceAdapter({ httpFetch });
    const params = enrichParams();
    await expect(adapter.enrichCompany(params)).rejects.toThrow(/PDL HTTP 429/);
    expect(params.onVendorFailure).not.toHaveBeenCalled();
  });

  it('surfaces a timeout (AbortError) as "request timed out"', async () => {
    const httpFetch = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const adapter = new PdlSourceAdapter({ httpFetch });
    await expect(adapter.enrichCompany(enrichParams())).rejects.toThrow(
      /PDL request failed: request timed out/,
    );
  });

  it('stringifies a non-Error transport throw', async () => {
    const httpFetch = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'socket boom';
    });
    const adapter = new PdlSourceAdapter({ httpFetch });
    await expect(adapter.enrichCompany(enrichParams())).rejects.toThrow(
      /PDL request failed: socket boom/,
    );
  });

  it('throws on a non-JSON body', async () => {
    const httpFetch = vi.fn(
      async () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const adapter = new PdlSourceAdapter({ httpFetch });
    await expect(adapter.enrichCompany(enrichParams())).rejects.toThrow(/non-JSON/);
  });

  it('normalizes missing optional fields to null', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse({ status: 200, name: 'bare co' }),
    );
    const adapter = new PdlSourceAdapter({ httpFetch });
    const record = await adapter.enrichCompany(enrichParams());
    expect(record).toMatchObject({
      domain: null,
      linkedinUrl: null,
      employeeCount: null,
      industry: null,
      location: null,
    });
  });

  it('maps an unparseable website to a null domain', async () => {
    const httpFetch = fetchReturning(() =>
      jsonResponse(pdlCompany({ website: 'http://[' })),
    );
    const adapter = new PdlSourceAdapter({ httpFetch });
    const record = await adapter.enrichCompany(enrichParams());
    expect(record?.domain).toBeNull();
  });

  it('keeps an already-absolute linkedin url unchanged', async () => {
    const httpFetch = vi.fn(async () =>
      jsonResponse(pdlCompany({ linkedin_url: 'https://www.linkedin.com/company/x' })),
    );
    const adapter = new PdlSourceAdapter({ httpFetch });
    const record = await adapter.enrichCompany(enrichParams());
    expect(record?.linkedinUrl).toBe('https://www.linkedin.com/company/x');
  });
});
