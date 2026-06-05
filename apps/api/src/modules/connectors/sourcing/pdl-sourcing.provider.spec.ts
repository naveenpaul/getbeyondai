import { describe, expect, it, vi } from 'vitest';
import type { DecryptedCredentials } from '@getbeyond/shared';
import {
  PdlAuthError,
  PdlInsufficientCreditsError,
  type PdlCompanySearchParams,
  type PdlCompanySearchResponse,
} from '../adapters/pdl/pdl.source';
import { SourcingUnavailableError } from './sourcing-provider';
import type { IcpCriteria } from './sourcing-provider';
import type { VendorHealthReporter } from './apollo-sourcing.provider';
import {
  PdlSourcingProvider,
  icpToPdlSearchQuery,
  pdlIndustriesFor,
  pdlSizeBuckets,
  toCandidate,
  type PdlCompanySearcher,
} from './pdl-sourcing.provider';

const CREDS: DecryptedCredentials = { apiKey: 'k' };

function icp(overrides: Partial<IcpCriteria> = {}): IcpCriteria {
  return {
    keywords: [],
    employeeCountMin: null,
    employeeCountMax: null,
    fundingStages: [],
    industries: [],
    locations: [],
    ...overrides,
  };
}

function noopHealth(): VendorHealthReporter {
  return {
    reportVendorFailure: vi.fn(async () => {}),
    reportVendorSuccess: vi.fn(),
  };
}

function stubSearcher(
  response: PdlCompanySearchResponse,
): { searcher: PdlCompanySearcher; calls: () => PdlCompanySearchParams[] } {
  const fn = vi.fn(async (_p: PdlCompanySearchParams) => response);
  return { searcher: { searchCompanies: fn }, calls: () => fn.mock.calls.map((c) => c[0]) };
}

describe('pdlSizeBuckets', () => {
  it('returns the buckets overlapping [min, max]', () => {
    expect(pdlSizeBuckets(1, 50)).toEqual(['1-10', '11-50']);
    expect(pdlSizeBuckets(null, 50)).toEqual(['1-10', '11-50']);
  });

  it('maps a large floor to the open-ended bucket', () => {
    expect(pdlSizeBuckets(20000, null)).toEqual(['10001+']);
  });
});

describe('pdlIndustriesFor', () => {
  it('maps common terms onto the PDL industry vocabulary, deduped', () => {
    expect(pdlIndustriesFor(['IT', 'software'])).toEqual([
      'information technology and services',
      'computer software',
      'internet',
    ]);
  });

  it('excludes PDL\'s non-tech "information services" catch-all from IT terms', () => {
    // Verified live: "information services" pulls in job boards / consultancies.
    expect(pdlIndustriesFor(['IT'])).not.toContain('information services');
    expect(pdlIndustriesFor(['information technology'])).not.toContain(
      'information services',
    );
  });

  it('drops unmapped terms (e.g. "startup")', () => {
    expect(pdlIndustriesFor(['startup'])).toEqual([]);
  });
});

describe('icpToPdlSearchQuery', () => {
  it('routes a city to location.locality (alias-normalized) — the Bengaluru case', () => {
    const q = icpToPdlSearchQuery(
      icp({ locations: ['Bengaluru'], keywords: ['IT'], employeeCountMax: 50 }),
    );
    expect(q).toEqual({
      bool: {
        must: [
          { terms: { 'location.locality': ['bangalore'] } },
          {
            bool: {
              should: [
                { term: { industry: 'information technology and services' } },
                { term: { industry: 'computer software' } },
                { term: { industry: 'internet' } },
              ],
            },
          },
          { terms: { size: ['1-10', '11-50'] } },
        ],
      },
    });
  });

  it('routes a country to location.country (lowercased)', () => {
    const q = icpToPdlSearchQuery(icp({ locations: ['United Kingdom'] }));
    expect(q).toEqual({
      bool: { must: [{ terms: { 'location.country': ['united kingdom'] } }] },
    });
  });

  it('splits mixed country + city locations', () => {
    const q = icpToPdlSearchQuery(icp({ locations: ['India', 'Bengaluru'] }));
    expect(q).toEqual({
      bool: {
        must: [
          { terms: { 'location.country': ['india'] } },
          { terms: { 'location.locality': ['bangalore'] } },
        ],
      },
    });
  });

  it('yields match_all for an empty ICP', () => {
    expect(icpToPdlSearchQuery(icp())).toEqual({ match_all: {} });
  });
});

describe('toCandidate', () => {
  it('maps a PDL record to a candidate', () => {
    const record = {
      name: 'timetraverse',
      display_name: 'TimeTraverse',
      website: 'https://www.timetraverse.com/about',
      linkedin_url: 'linkedin.com/company/timetraverse',
      employee_count: 7,
      size: '1-10',
      industry: 'information technology and services',
    };
    expect(toCandidate(record)).toEqual({
      name: 'TimeTraverse',
      domain: 'timetraverse.com',
      linkedinUrl: 'https://linkedin.com/company/timetraverse',
      employeeCount: 7,
      fundingStage: null,
      raw: record,
    });
  });

  it('returns null when there is no name', () => {
    expect(toCandidate({ website: 'x.com' })).toBeNull();
  });

  it('null-fills missing optional fields', () => {
    expect(toCandidate({ name: 'bare co' })).toMatchObject({
      domain: null,
      linkedinUrl: null,
      employeeCount: null,
      fundingStage: null,
    });
  });
});

describe('PdlSourcingProvider.findCandidates', () => {
  it('searches with the mapped query + size and returns candidates', async () => {
    const { searcher, calls } = stubSearcher({
      total: 11705,
      records: [
        { name: 'timetraverse', website: 'timetraverse.com', employee_count: 7 },
        { name: 'quintessential', website: 'quintessential.io' },
      ],
    });
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(
      icp({ locations: ['Bengaluru'], keywords: ['IT'] }),
      { limit: 25 },
    );
    expect(result.candidates.map((c) => c.name)).toEqual([
      'timetraverse',
      'quintessential',
    ]);
    expect(result.summary).toMatch(/PDL: 2 companies.*11,705/);
    const arg = calls()[0];
    expect(arg?.size).toBe(25);
    expect(arg?.query).toMatchObject({ bool: { must: expect.any(Array) } });
  });

  it('dedupes by domain (falling back to name)', async () => {
    const { searcher } = stubSearcher({
      total: 3,
      records: [
        { name: 'Acme', website: 'acme.com' },
        { name: 'Acme Dup', website: 'https://www.acme.com' },
        { name: 'Beta', website: null },
      ],
    });
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(icp());
    expect(result.candidates.map((c) => c.name)).toEqual(['Acme', 'Beta']);
  });

  it('honors the limit', async () => {
    const { searcher } = stubSearcher({
      total: 3,
      records: [
        { name: 'A', website: 'a.com' },
        { name: 'B', website: 'b.com' },
        { name: 'C', website: 'c.com' },
      ],
    });
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(icp(), { limit: 2 });
    expect(result.candidates).toHaveLength(2);
  });

  it('wires the breaker hooks to the health reporter with the account id', async () => {
    const { searcher, calls } = stubSearcher({ total: 0, records: [] });
    const health = noopHealth();
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct-9', health);
    await provider.findCandidates(icp());
    const arg = calls()[0];
    await arg?.onVendorFailure?.('server_5xx');
    arg?.onVendorSuccess?.();
    expect(health.reportVendorFailure).toHaveBeenCalledWith('acct-9', 'server_5xx');
    expect(health.reportVendorSuccess).toHaveBeenCalledWith('acct-9');
  });

  it('maps a rejected key to a graceful SourcingUnavailableError', async () => {
    const searcher: PdlCompanySearcher = {
      searchCompanies: async () => {
        throw new PdlAuthError('PDL rejected the API key (HTTP 401)');
      },
    };
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct', noopHealth());
    await expect(provider.findCandidates(icp())).rejects.toBeInstanceOf(
      SourcingUnavailableError,
    );
    await expect(provider.findCandidates(icp())).rejects.toThrow(/reconnect PDL/i);
  });

  it('maps out-of-credits to a graceful "top up" SourcingUnavailableError', async () => {
    const searcher: PdlCompanySearcher = {
      searchCompanies: async () => {
        throw new PdlInsufficientCreditsError('out of credits');
      },
    };
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct', noopHealth());
    await expect(provider.findCandidates(icp())).rejects.toThrow(/top up PDL/i);
  });

  it('rethrows an unexpected error (transient) so pg-boss can retry', async () => {
    const searcher: PdlCompanySearcher = {
      searchCompanies: async () => {
        throw new Error('PDL server error (HTTP 503)');
      },
    };
    const provider = new PdlSourcingProvider(searcher, CREDS, 'acct', noopHealth());
    await expect(provider.findCandidates(icp())).rejects.toThrow(/503/);
  });
});
