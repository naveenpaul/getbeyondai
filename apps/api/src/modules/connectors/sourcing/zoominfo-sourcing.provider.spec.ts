import { describe, expect, it, vi } from 'vitest';
import {
  ZoomInfoAuthError,
  ZoomInfoBadRequestError,
  ZoomInfoServerError,
  type ZoomInfoCompanySearchAttributes,
  type ZoomInfoDocument,
} from '../adapters/zoominfo/zoominfo.source';
import { SourcingUnavailableError } from './sourcing-provider';
import type { IcpCriteria } from './sourcing-provider';
import type { VendorHealthReporter } from './apollo-sourcing.provider';
import {
  ZoomInfoSourcingProvider,
  employeeCountBuckets,
  icpToZoomInfoCompanyCriteria,
  toCandidate,
  toDomain,
  type ZoomInfoCompanySearcher,
} from './zoominfo-sourcing.provider';

const EMPTY_ICP: IcpCriteria = {
  keywords: [],
  employeeCountMin: null,
  employeeCountMax: null,
  fundingStages: [],
  industries: [],
  locations: [],
};

/** A health reporter that records calls. */
function fakeHealth(): VendorHealthReporter & {
  failures: Array<{ accountId: string; kind: string }>;
  successes: string[];
} {
  const failures: Array<{ accountId: string; kind: string }> = [];
  const successes: string[] = [];
  return {
    failures,
    successes,
    reportVendorFailure: async (accountId, kind) => {
      failures.push({ accountId, kind });
    },
    reportVendorSuccess: (accountId) => {
      successes.push(accountId);
    },
  };
}

/** A searcher returning the given docs page-by-page (then empty). */
function searcherReturning(pages: ZoomInfoDocument[]): ZoomInfoCompanySearcher {
  return {
    searchCompanies: vi.fn(async (_attrs, opts) => {
      const page = opts?.page ?? 1;
      return pages[page - 1] ?? { data: [] };
    }),
  };
}

/** Build a JSON:API company resource. */
function company(attrs: Record<string, unknown>, id = '1'): unknown {
  return { type: 'CompanySearch', id, attributes: attrs };
}

describe('ZoomInfoSourcingProvider.findCandidates', () => {
  it('maps a company resource to a vendor-neutral candidate', async () => {
    const searcher = searcherReturning([
      {
        data: [
          company({
            companyName: 'Acme Inc',
            companyWebsite: 'https://www.Acme.com/about',
            employeeCount: 42,
            fundingStage: 'series_a',
          }),
        ],
      },
    ]);
    const provider = new ZoomInfoSourcingProvider(searcher, 'acct-1', fakeHealth());
    const { candidates } = await provider.findCandidates(EMPTY_ICP, { limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: 'Acme Inc',
      domain: 'acme.com',
      employeeCount: 42,
      fundingStage: 'series_a',
    });
  });

  it('skips resources with no company name', async () => {
    const searcher = searcherReturning([
      { data: [company({ companyWebsite: 'x.com' }), company({ name: 'Real' }, '2')] },
    ]);
    const provider = new ZoomInfoSourcingProvider(searcher, 'a', fakeHealth());
    const { candidates } = await provider.findCandidates(EMPTY_ICP, { limit: 10 });
    expect(candidates.map((c) => c.name)).toEqual(['Real']);
  });

  it('dedupes by domain across pages', async () => {
    const provider = new ZoomInfoSourcingProvider(
      searcherReturning([
        { data: [company({ name: 'A', domain: 'a.com' }, '1')] },
        { data: [company({ name: 'A dup', domain: 'a.com' }, '2')] },
      ]),
      'a',
      fakeHealth(),
      { pageSize: 1 },
    );
    const { candidates } = await provider.findCandidates(EMPTY_ICP);
    expect(candidates).toHaveLength(1);
  });

  it('respects the limit', async () => {
    const provider = new ZoomInfoSourcingProvider(
      searcherReturning([
        {
          data: [
            company({ name: 'A', domain: 'a.com' }, '1'),
            company({ name: 'B', domain: 'b.com' }, '2'),
            company({ name: 'C', domain: 'c.com' }, '3'),
          ],
        },
      ]),
      'a',
      fakeHealth(),
    );
    const { candidates } = await provider.findCandidates(EMPTY_ICP, { limit: 2 });
    expect(candidates).toHaveLength(2);
  });

  it('maps an auth error to a graceful SourcingUnavailableError + reports it', async () => {
    const health = fakeHealth();
    const searcher: ZoomInfoCompanySearcher = {
      searchCompanies: async () => {
        throw new ZoomInfoAuthError('401');
      },
    };
    const provider = new ZoomInfoSourcingProvider(searcher, 'acct-1', health);
    await expect(provider.findCandidates(EMPTY_ICP)).rejects.toBeInstanceOf(
      SourcingUnavailableError,
    );
    expect(health.failures).toEqual([{ accountId: 'acct-1', kind: 'auth_invalid' }]);
  });

  it('maps a 400 bad-criteria error to a graceful SourcingUnavailableError', async () => {
    const health = fakeHealth();
    const searcher: ZoomInfoCompanySearcher = {
      searchCompanies: async () => {
        throw new ZoomInfoBadRequestError(
          'ZoomInfo rejected the search criteria (HTTP 400)',
        );
      },
    };
    const provider = new ZoomInfoSourcingProvider(searcher, 'acct-1', health);
    // Graceful: a non-retryable criteria error completes the search (ICP shown)
    // rather than dumping the raw vendor error as search_failed.
    await expect(provider.findCandidates(EMPTY_ICP)).rejects.toBeInstanceOf(
      SourcingUnavailableError,
    );
    await expect(provider.findCandidates(EMPTY_ICP)).rejects.toThrow(
      /filters by country, not city/i,
    );
  });

  it('reports a server error and rethrows it (transient, NOT graceful)', async () => {
    const health = fakeHealth();
    const searcher: ZoomInfoCompanySearcher = {
      searchCompanies: async () => {
        throw new ZoomInfoServerError('500');
      },
    };
    const provider = new ZoomInfoSourcingProvider(searcher, 'acct-1', health);
    await expect(provider.findCandidates(EMPTY_ICP)).rejects.toBeInstanceOf(
      ZoomInfoServerError,
    );
    expect(health.failures).toEqual([{ accountId: 'acct-1', kind: 'server_5xx' }]);
  });
});

describe('employeeCountBuckets', () => {
  it('returns all buckets when both bounds are open', () => {
    expect(employeeCountBuckets(null, null)).toHaveLength(11);
  });
  it('caps at the bucket overlapping the max', () => {
    expect(employeeCountBuckets(null, 200)).toEqual([
      '1to4',
      '5to9',
      '10to19',
      '20to49',
      '50to99',
      '100to249',
    ]);
  });
  it('selects only buckets overlapping [min, max]', () => {
    expect(employeeCountBuckets(10, 200)).toEqual([
      '10to19',
      '20to49',
      '50to99',
      '100to249',
    ]);
  });
  it('maps a large floor to the open-ended bucket', () => {
    expect(employeeCountBuckets(10000, null)).toEqual(['10000plus']);
  });
});

describe('icpToZoomInfoCompanyCriteria (verified live 2026-06-04)', () => {
  it('emits an empty attribute set for an empty ICP', () => {
    expect(icpToZoomInfoCompanyCriteria(EMPTY_ICP)).toEqual({});
  });

  it('maps headcount→buckets, locations→country, keywords+industries→companyDescription', () => {
    const attrs: ZoomInfoCompanySearchAttributes = icpToZoomInfoCompanyCriteria({
      keywords: ['devtools', 'API'],
      employeeCountMin: 10,
      employeeCountMax: 200,
      fundingStages: ['series_a'],
      industries: ['Fintech'],
      locations: ['United Kingdom', 'Ireland'],
    });
    expect(attrs['employeeCount']).toBe('10to19,20to49,50to99,100to249');
    expect(attrs['country']).toBe('United Kingdom,Ireland');
    expect(attrs['companyDescription']).toBe('devtools API Fintech');
    // fundingStages have no ZoomInfo filter — not emitted.
    expect(attrs).not.toHaveProperty('fundingStage');
  });

  it('routes a non-country location (a city) to the description, NOT country', () => {
    // The "find … startups in Bengaluru" regression: a city in `country` 400s.
    const attrs = icpToZoomInfoCompanyCriteria({
      ...EMPTY_ICP,
      keywords: ['IT', 'startup'],
      locations: ['Bengaluru'],
    });
    expect(attrs).not.toHaveProperty('country');
    expect(attrs['companyDescription']).toBe('IT startup Bengaluru');
  });

  it('splits mixed locations: countries → country, the rest → description', () => {
    const attrs = icpToZoomInfoCompanyCriteria({
      ...EMPTY_ICP,
      keywords: ['fintech'],
      locations: ['United States', 'Bengaluru', 'California'],
    });
    expect(attrs['country']).toBe('United States');
    expect(attrs['companyDescription']).toBe('fintech Bengaluru California');
  });

  it('normalizes common country aliases (US, UK) to canonical names', () => {
    const attrs = icpToZoomInfoCompanyCriteria({
      ...EMPTY_ICP,
      locations: ['US', 'uk'],
    });
    expect(attrs['country']).toBe('United States,United Kingdom');
  });

  it('omits country entirely when no location is a recognized country', () => {
    const attrs = icpToZoomInfoCompanyCriteria({
      ...EMPTY_ICP,
      locations: ['Bengaluru', 'Mumbai'],
    });
    expect(attrs).not.toHaveProperty('country');
    expect(attrs['companyDescription']).toBe('Bengaluru Mumbai');
  });
});

describe('toCandidate / toDomain', () => {
  it('normalizes a URL to a bare hostname', () => {
    expect(toDomain('https://www.Example.com/path?q=1')).toBe('example.com');
    expect(toDomain('Example.com')).toBe('example.com');
    expect(toDomain('')).toBeNull();
    expect(toDomain(null)).toBeNull();
  });

  it('returns null for a resource with no name', () => {
    expect(toCandidate({ attributes: { domain: 'x.com' } })).toBeNull();
    expect(toCandidate(null)).toBeNull();
  });
});
