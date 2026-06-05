import { z } from 'zod';
import type { AgentTool, ToolContext } from '../agent-tool';
import type { SearchProvider, SearchOutput } from '../search/search-provider';
import { searchProviderFromEnv } from '../search/registry';

/**
 * web_search — web search via the configured `SearchProvider` (T4b.2).
 *
 * The Researcher's primary discovery tool. Every result the model later cites
 * becomes a `Citation` row via fetch_url; web_search itself does NOT create
 * Citation rows (the snippet alone isn't a citation — the model still needs to
 * fetch the page to ground a claim).
 *
 * The engine is swappable behind the `SearchProvider` seam: `brave` (Brave
 * Search API, the Cloud default) or `searxng` (self-hosted, keyless — the
 * self-host default), selected via `SEARCH_PROVIDER` / `SEARXNG_URL`. This tool
 * owns only the model-facing contract (name, schema, output shape); WHICH engine
 * serves the query is the provider's concern. See
 * docs/plans/search-provider-abstraction.md.
 */

export const WebSearchInputSchema = z.object({
  query: z.string().min(1, 'query is required'),
  count: z.number().int().min(1).max(20).optional(),
});

export interface WebSearchDeps {
  /**
   * Search backend. Defaults to the env-configured provider, resolved lazily on
   * first use so module import neither reads env nor throws on a misconfigured
   * (e.g. searxng-without-URL) setup. Tests inject a fake.
   */
  searchProvider?: SearchProvider;
}

export function buildWebSearchTool(deps: WebSearchDeps = {}): AgentTool {
  // Resolve the provider lazily + memoize, mirroring fetch_url: don't read env /
  // risk a config throw until the tool is actually used.
  let provider = deps.searchProvider;
  const getProvider = (): SearchProvider => {
    if (!provider) provider = searchProviderFromEnv();
    return provider;
  };

  return {
    name: 'web_search',
    description:
      'Web search. Returns up to 10 results with title, url, description, and ' +
      'age. Use this to discover sources; call fetch_url on each result you ' +
      'want to cite (only fetched pages can be used as Citations for ' +
      'emit_draft claims).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<SearchOutput> {
      const parsed = WebSearchInputSchema.parse(args);
      return getProvider().search(parsed.query, { count: parsed.count });
    },
  };
}

/** Default singleton — wired from RuntimeModule. Uses the env-configured provider. */
export const webSearchTool = buildWebSearchTool();
