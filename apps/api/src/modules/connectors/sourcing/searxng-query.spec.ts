import { describe, expect, it } from 'vitest';
import type { IcpCriteria } from './sourcing-provider';
import { compileSearxngQuery, pickNiche } from './searxng-query';

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

describe('pickNiche', () => {
  it('prefers a concrete industry over keywords', () => {
    expect(pickNiche(icp({ industries: ['payroll software'], keywords: ['HR'] }))).toBe(
      'payroll software',
    );
  });

  it('falls back to a specific keyword, skipping generic terms', () => {
    expect(
      pickNiche(icp({ keywords: ['IT', 'startup', 'devtools', 'seed'] })),
    ).toBe('devtools');
  });

  it('returns null when the ICP names only generic terms', () => {
    expect(pickNiche(icp({ keywords: ['startup', 'technology', 'seed'] }))).toBeNull();
  });
});

describe('compileSearxngQuery', () => {
  it('exact-matches the niche + geography and bans default aggregators', () => {
    const q = compileSearxngQuery(
      icp({ industries: ['payroll software'], locations: ['Austin'] }),
    );
    expect(q).toContain('"payroll software"');
    expect(q).toContain('"Austin"');
    expect(q).toContain('-agency');
    expect(q).toContain('-wikipedia');
  });

  it('adds small-company site signals when employeeCountMax is low', () => {
    const q = compileSearxngQuery(
      icp({ industries: ['crm'], employeeCountMax: 50 }),
    );
    expect(q).toContain('"pricing"');
    expect(q).toContain('"book a demo"');
  });

  it('omits the scale signal for large/unbounded targets', () => {
    expect(compileSearxngQuery(icp({ industries: ['crm'] }))).not.toContain('pricing');
    expect(
      compileSearxngQuery(icp({ industries: ['crm'], employeeCountMax: 5000 })),
    ).not.toContain('pricing');
  });

  it('merges + dedupes caller negative keywords with the defaults', () => {
    const q = compileSearxngQuery(icp({ industries: ['crm'] }), {
      negativeKeywords: ['consulting', 'AGENCY'],
    });
    expect(q).toContain('-consulting');
    // 'agency' is a default; the duplicate 'AGENCY' must not appear twice.
    expect(q.match(/-agency/g)).toHaveLength(1);
  });

  it('adds a site: scope for engine routing', () => {
    const q = compileSearxngQuery(icp({ industries: ['crm'] }), {
      siteScope: 'linkedin.com',
    });
    expect(q).toContain('site:linkedin.com');
  });

  it('still produces a usable query with only geography (no niche)', () => {
    const q = compileSearxngQuery(icp({ keywords: ['startup'], locations: ['Berlin'] }));
    expect(q).toContain('"Berlin"');
    expect(q).not.toContain('""');
  });
});
