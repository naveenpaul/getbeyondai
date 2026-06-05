import { describe, expect, it, vi } from 'vitest';
import { buildWebSearchTool } from './web-search';
import type { SearchProvider, SearchOutput } from '../search/search-provider';
import type { ToolContext } from '../agent-tool';

function fakeCtx(): ToolContext {
  return { runId: 'run-1', orgId: 'org-A', prisma: {} as never };
}

function stubProvider(
  out: SearchOutput,
): { provider: SearchProvider; calls: () => Array<[string, { count?: number } | undefined]> } {
  const fn = vi.fn(async (_q: string, _opts?: { count?: number }) => out);
  return {
    provider: { name: 'stub', search: fn },
    calls: () => fn.mock.calls as Array<[string, { count?: number } | undefined]>,
  };
}

describe('web_search tool', () => {
  it('declares name web_search', () => {
    // No provider passed → resolved lazily on execute only, so build is safe.
    expect(buildWebSearchTool().name).toBe('web_search');
  });

  it('delegates to the injected provider and returns its output', async () => {
    const out: SearchOutput = {
      query: 'acme',
      results: [{ title: 'Acme', url: 'https://acme.com', description: 'd', age: null }],
    };
    const { provider, calls } = stubProvider(out);
    const tool = buildWebSearchTool({ searchProvider: provider });
    const result = await tool.execute({ query: 'acme', count: 5 }, fakeCtx());
    expect(result).toEqual(out);
    expect(calls()[0]).toEqual(['acme', { count: 5 }]);
  });

  it('rejects an empty query at the Zod boundary', async () => {
    const { provider } = stubProvider({ query: '', results: [] });
    const tool = buildWebSearchTool({ searchProvider: provider });
    await expect(tool.execute({ query: '' }, fakeCtx())).rejects.toThrow();
  });

  it('rejects count outside [1, 20]', async () => {
    const { provider } = stubProvider({ query: 'x', results: [] });
    const tool = buildWebSearchTool({ searchProvider: provider });
    await expect(tool.execute({ query: 'x', count: 0 }, fakeCtx())).rejects.toThrow();
    await expect(tool.execute({ query: 'x', count: 25 }, fakeCtx())).rejects.toThrow();
  });
});
