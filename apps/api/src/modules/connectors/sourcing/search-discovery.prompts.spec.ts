import { describe, expect, it } from 'vitest';
import {
  MAX_DISCOVERY_QUERIES,
  MAX_EXEMPLARS,
  buildDiscoveryQueryUserPrompt,
  buildNormalizeUserPrompt,
  isListShaped,
  parseDiscoveredCompanies,
  parseDiscoveryQueries,
  selectExemplars,
} from './search-discovery.prompts';
import type { IcpCriteria } from './sourcing-provider';

const ICP: IcpCriteria = {
  keywords: ['IT', 'startup'],
  employeeCountMin: null,
  employeeCountMax: 50,
  fundingStages: ['seed'],
  industries: ['computer software'],
  locations: ['Bengaluru'],
};

describe('selectExemplars', () => {
  it('caps at MAX_EXEMPLARS, preserving order', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Co${i}`);
    const out = selectExemplars(many);
    expect(out).toHaveLength(MAX_EXEMPLARS);
    expect(out[0]).toBe('Co0');
  });

  it('dedupes case-insensitively and drops blanks', () => {
    expect(selectExemplars(['Acme', 'acme', '  ', 'Globex'])).toEqual([
      'Acme',
      'Globex',
    ]);
  });

  it('honors a custom max', () => {
    expect(selectExemplars(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('parseDiscoveryQueries', () => {
  it('parses the object form, validates category, defaults angle', () => {
    const out = parseDiscoveryQueries(
      '{"queries":[{"q":"seed startups bengaluru 2026","category":"news"},{"q":"new saas bangalore","category":"bogus","angle":"segment"}]}',
    );
    expect(out).toEqual([
      { q: 'seed startups bengaluru 2026', category: 'news', angle: '' },
      { q: 'new saas bangalore', category: 'general', angle: 'segment' },
    ]);
  });

  it('tolerates a markdown fence and a bare array', () => {
    const out = parseDiscoveryQueries(
      '```json\n[{"q":"funded it startups","category":"news","angle":"a"}]\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.q).toBe('funded it startups');
  });

  it('drops items without a non-empty q and caps at MAX_DISCOVERY_QUERIES', () => {
    const items = Array.from({ length: 6 }, (_, i) => `{"q":"q${i}"}`).join(',');
    const out = parseDiscoveryQueries(`{"queries":[{"q":""},{"x":1},${items}]}`);
    expect(out).toHaveLength(MAX_DISCOVERY_QUERIES);
    expect(out.every((q) => q.q.length > 0)).toBe(true);
  });

  it('returns [] on unparseable text (no throw)', () => {
    expect(parseDiscoveryQueries('not json at all')).toEqual([]);
    expect(parseDiscoveryQueries('')).toEqual([]);
  });
});

describe('parseDiscoveredCompanies', () => {
  it('extracts companies, coercing absent fields to null', () => {
    const out = parseDiscoveredCompanies(
      '{"companies":[{"name":"Propsoch","fundingStage":"seed","amountUsd":2000000,"announcedDate":"2026-04-29","sourceUrl":"https://x.com/a","domain":"propsoch.com"}]}',
    );
    expect(out).toEqual([
      {
        name: 'Propsoch',
        domain: 'propsoch.com',
        fundingStage: 'seed',
        amountUsd: 2000000,
        announcedDate: '2026-04-29',
        sourceUrl: 'https://x.com/a',
      },
    ]);
  });

  it('drops items with no name and nulls ill-typed fields', () => {
    const out = parseDiscoveredCompanies(
      '{"companies":[{"name":""},{"name":"STAN","amountUsd":"lots","domain":123}]}',
    );
    expect(out).toEqual([
      {
        name: 'STAN',
        domain: null,
        fundingStage: null,
        amountUsd: null,
        announcedDate: null,
        sourceUrl: null,
      },
    ]);
  });

  it('tolerates a bare array + fence, returns [] on junk', () => {
    expect(
      parseDiscoveredCompanies('```\n[{"name":"Sahi"}]\n```'),
    ).toHaveLength(1);
    expect(parseDiscoveredCompanies('garbage')).toEqual([]);
  });
});

describe('prompt builders', () => {
  it('query prompt names the ICP fields and the exemplars (not as targets)', () => {
    const p = buildDiscoveryQueryUserPrompt(
      ICP,
      'find funded startups',
      ['Stripe', 'Linear'],
      ['raised seed in last 3 months'],
    );
    expect(p).toContain('Bengaluru');
    expect(p).toContain('computer software');
    expect(p).toContain('Stripe, Linear');
    expect(p).toContain('raised seed in last 3 months');
    expect(p).toContain('NOT targets');
  });

  it('normalize prompt numbers results and includes url + snippet', () => {
    const p = buildNormalizeUserPrompt([
      { title: 'Propsoch raises $2M', url: 'https://n.com/a', description: 'seed', age: '2026-04-29' },
    ]);
    expect(p).toContain('[1] Propsoch raises $2M');
    expect(p).toContain('url: https://n.com/a');
    expect(p).toContain('date: 2026-04-29');
  });

  it('normalize prompt appends fetched list pages to mine, when given', () => {
    const p = buildNormalizeUserPrompt(
      [{ title: 'x', url: 'https://n.com/a', description: 'y', age: null }],
      [
        {
          url: 'https://list.com/top',
          title: 'Top 29 Bangalore Startups',
          text: 'Signzy, Slice, Razorpay, …',
        },
      ],
    );
    expect(p).toContain('List pages');
    expect(p).toContain('[LIST 1] Top 29 Bangalore Startups');
    expect(p).toContain('Signzy, Slice, Razorpay');
  });

  it('omits the list-pages section when none are fetched', () => {
    const p = buildNormalizeUserPrompt([
      { title: 'x', url: 'https://n.com/a', description: 'y', age: null },
    ]);
    expect(p).not.toContain('List pages');
  });
});

describe('isListShaped', () => {
  it('flags "top N", "N+ startups", "best/leading", "list of", "to watch", roundups', () => {
    const yes = [
      { title: 'Top 29 Bangalore Startups', description: '' },
      { title: '505+ Funded Bangalore Startups 2026', description: 'verified' },
      { title: 'Best fintech startups in India', description: '' },
      { title: 'A list of early stage startups in Karnataka', description: '' },
      { title: 'Startups to watch in 2026', description: '' },
      { title: 'Bengaluru ecosystem', description: 'league table of companies' },
    ];
    for (const h of yes) expect(isListShaped(h)).toBe(true);
  });

  it('does not flag a single-company page/news hit', () => {
    const no = [
      { title: 'Signzy — fraud-prevention APIs', description: 'Signzy homepage' },
      { title: 'Acme raises $2M seed', description: 'funding news' },
    ];
    for (const h of no) expect(isListShaped(h)).toBe(false);
  });

  it('handles empty ICP lists gracefully', () => {
    const empty: IcpCriteria = {
      keywords: [],
      employeeCountMin: null,
      employeeCountMax: null,
      fundingStages: [],
      industries: [],
      locations: [],
    };
    const p = buildDiscoveryQueryUserPrompt(empty, '', [], []);
    expect(p).toContain('(none)');
    expect(p).toContain('(none stated)');
  });
});
