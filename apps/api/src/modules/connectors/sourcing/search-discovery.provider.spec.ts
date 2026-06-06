import { describe, expect, it, vi } from 'vitest';
import {
  SearchDiscoverySourcingProvider,
  filterByRecency,
  type SearchDiscoveryDeps,
} from './search-discovery.provider';
import {
  DISCOVERY_QUERY_BUILDER_SYSTEM_PROMPT,
} from './search-discovery.prompts';
import { SearchProviderError } from '../../teammates/runtime/search/search-provider';
import type { CandidateCompany, IcpCriteria } from './sourcing-provider';

const ICP: IcpCriteria = {
  keywords: ['IT'],
  employeeCountMin: null,
  employeeCountMax: 50,
  fundingStages: ['seed'],
  industries: ['computer software'],
  locations: ['Bengaluru'],
};

const QUERIES_JSON = '{"queries":[{"q":"funded it startups bengaluru 2026","category":"news","angle":"funding"}]}';

/** A fake searcher returning fixed results for any query. */
function searcherReturning(
  results: Array<{ title: string; url: string; description: string; age: string | null }>,
) {
  return {
    search: vi.fn(async (query: string) => ({ query, results })),
  };
}

/** A chat stub: returns query JSON for the builder system prompt, else normalize JSON. */
function chatStub(normalizeJson: string, queriesJson = QUERIES_JSON) {
  return vi.fn(async (system: string) =>
    system === DISCOVERY_QUERY_BUILDER_SYSTEM_PROMPT ? queriesJson : normalizeJson,
  );
}

function deps(over: Partial<SearchDiscoveryDeps>): SearchDiscoveryDeps {
  return {
    searcher: searcherReturning([
      { title: 'Propsoch raises $2M', url: 'https://n.com/a', description: 'seed', age: null },
    ]),
    chat: chatStub('{"companies":[{"name":"Propsoch","domain":"propsoch.com"}]}'),
    winNames: ['Acme'],
    winKeys: [{ name: 'Acme' }],
    intent: 'find funded startups',
    now: new Date('2026-06-06T00:00:00Z'),
    ...over,
  };
}

describe('SearchDiscoverySourcingProvider.findCandidates', () => {
  it('builds queries, searches, normalizes, and returns candidates', async () => {
    const p = new SearchDiscoverySourcingProvider(deps({}));
    const res = await p.findCandidates(ICP);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.name).toBe('Propsoch');
    expect(res.candidates[0]!.domain).toBe('propsoch.com');
    // funding signal carried in raw for the Researcher.
    expect(res.candidates[0]!.raw['source']).toBe('search-discovery');
  });

  it('returns empty (no throw) when the query builder yields no queries', async () => {
    const p = new SearchDiscoverySourcingProvider(
      deps({ chat: chatStub('{}', '{"queries":[]}') }),
    );
    const res = await p.findCandidates(ICP);
    expect(res.candidates).toEqual([]);
  });

  it('returns empty when the query-build chat throws (graceful → fallback)', async () => {
    const chat = vi.fn(async (system: string) => {
      if (system === DISCOVERY_QUERY_BUILDER_SYSTEM_PROMPT) throw new Error('LLM down');
      return '{}';
    });
    const p = new SearchDiscoverySourcingProvider(deps({ chat }));
    await expect(p.findCandidates(ICP)).resolves.toEqual({
      candidates: [],
      summary: expect.stringContaining('no new companies'),
    });
  });

  it('skips a query whose search errors and continues (no hard fail)', async () => {
    const searcher = {
      search: vi.fn(async (query: string) => {
        throw new SearchProviderError('rate limited', 'searxng');
      }),
    };
    const p = new SearchDiscoverySourcingProvider(deps({ searcher }));
    const res = await p.findCandidates(ICP);
    expect(res.candidates).toEqual([]); // no results → empty, but no throw
  });

  it('resolves a missing domain inline via resolveDomain', async () => {
    const resolveDomain = vi.fn(async () => 'https://www.STAN.io');
    const p = new SearchDiscoverySourcingProvider(
      deps({
        chat: chatStub('{"companies":[{"name":"STAN"}]}'),
        resolveDomain,
      }),
    );
    const res = await p.findCandidates(ICP);
    expect(resolveDomain).toHaveBeenCalledWith('STAN');
    expect(res.candidates[0]!.domain).toBe('stan.io');
  });

  it('drops a domainless candidate when no resolver is available (review #1)', async () => {
    const p = new SearchDiscoverySourcingProvider(
      deps({ chat: chatStub('{"companies":[{"name":"NoDomain Co"}]}') }),
    );
    const res = await p.findCandidates(ICP);
    expect(res.candidates).toHaveLength(0);
  });

  it('suppresses a discovered company already in the wins list', async () => {
    const p = new SearchDiscoverySourcingProvider(
      deps({
        chat: chatStub('{"companies":[{"name":"Acme","domain":"acme.com"}]}'),
        winKeys: [{ name: 'Acme', domain: 'acme.com' }],
      }),
    );
    const res = await p.findCandidates(ICP);
    expect(res.candidates).toHaveLength(0);
    expect(res.summary).toContain('already'); // surfaced as "already in your list"
  });

  it('honors the limit + dedupes by domain', async () => {
    const p = new SearchDiscoverySourcingProvider(
      deps({
        chat: chatStub(
          '{"companies":[{"name":"A","domain":"a.com"},{"name":"A dup","domain":"a.com"},{"name":"B","domain":"b.com"}]}',
        ),
        winKeys: [],
      }),
    );
    const res = await p.findCandidates(ICP, { limit: 1 });
    expect(res.candidates).toHaveLength(1);
  });
});

describe('filterByRecency', () => {
  const now = new Date('2026-06-06T00:00:00Z');
  const make = (announcedDate: string | null): CandidateCompany => ({
    name: 'x',
    domain: 'x.com',
    linkedinUrl: null,
    employeeCount: null,
    fundingStage: null,
    raw: { announcedDate },
  });

  it('drops dated candidates older than the window', () => {
    const out = filterByRecency([make('2026-01-01')], 3, now); // ~5mo old
    expect(out).toHaveLength(0);
  });

  it('keeps dated candidates within the window', () => {
    const out = filterByRecency([make('2026-05-01')], 3, now);
    expect(out).toHaveLength(1);
  });

  it('keeps undated and unparseable-date candidates (recall)', () => {
    expect(filterByRecency([make(null)], 3, now)).toHaveLength(1);
    expect(filterByRecency([make('not-a-date')], 3, now)).toHaveLength(1);
  });

  it('no-ops when withinMonths is null or <= 0', () => {
    expect(filterByRecency([make('2020-01-01')], null, now)).toHaveLength(1);
    expect(filterByRecency([make('2020-01-01')], 0, now)).toHaveLength(1);
  });
});
