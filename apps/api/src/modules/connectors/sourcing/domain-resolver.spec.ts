import { describe, expect, it, vi } from 'vitest';
import { pickCompanyDomain, resolveDomainViaSearch } from './domain-resolver';

describe('pickCompanyDomain', () => {
  it('prefers a domain whose first label matches a name token', () => {
    const urls = [
      'https://www.linkedin.com/company/propsoch',
      'https://entrackr.com/2026/04/propsoch-raises',
      'https://propsoch.com/',
    ];
    expect(pickCompanyDomain('Propsoch', urls)).toBe('propsoch.com');
  });

  it('skips aggregators and falls back to the first non-aggregator domain', () => {
    const urls = [
      'https://techcrunch.com/x',
      'https://crunchbase.com/org/y',
      'https://acme-io.com/about',
    ];
    expect(pickCompanyDomain('Totally Different Name', urls)).toBe('acme-io.com');
  });

  it('returns null when every candidate is an aggregator', () => {
    const urls = [
      'https://www.linkedin.com/company/x',
      'https://x.com/y',
      'https://economictimes.indiatimes.com/z',
    ];
    expect(pickCompanyDomain('Whatever', urls)).toBeNull();
  });

  it('matches when the domain label contains the name token', () => {
    expect(
      pickCompanyDomain('Sahi', ['https://getsahi.com', 'https://forbes.com/a']),
    ).toBe('getsahi.com');
  });

  it('returns null for no candidates', () => {
    expect(pickCompanyDomain('Acme', [])).toBeNull();
  });
});

describe('resolveDomainViaSearch', () => {
  it('searches for the official site and returns the picked domain', async () => {
    const searcher = {
      search: vi.fn(async (query: string) => ({
        query,
        results: [
          { title: 'x', url: 'https://linkedin.com/company/stan', description: '', age: null },
          { title: 'y', url: 'https://stan.store/', description: '', age: null },
        ],
      })),
    };
    const domain = await resolveDomainViaSearch(searcher, 'STAN');
    expect(searcher.search).toHaveBeenCalledWith('STAN official website', { count: 5 });
    expect(domain).toBe('stan.store');
  });

  it('returns null on a search failure (→ candidate dropped upstream)', async () => {
    const searcher = {
      search: vi.fn(async () => {
        throw new Error('engine down');
      }),
    };
    expect(await resolveDomainViaSearch(searcher, 'Acme')).toBeNull();
  });

  it('returns null for a blank name without searching', async () => {
    const searcher = { search: vi.fn() };
    expect(await resolveDomainViaSearch(searcher, '   ')).toBeNull();
    expect(searcher.search).not.toHaveBeenCalled();
  });
});
