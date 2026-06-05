import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderName,
} from './search-provider';
import { BraveSearchProvider } from './providers/brave.provider';
import { SearxngSearchProvider } from './providers/searxng.provider';

/**
 * Search provider registry — mirrors the LLM + content provider registries.
 *
 * A thin, exhaustive switch from a `SearchProviderName` to a concrete
 * `SearchProvider`. Adding a provider = adding a case here + its class; the
 * `never` exhaustiveness check makes a forgotten case a compile error.
 *
 * Default resolution (see docs/plans/search-provider-abstraction.md §6):
 * an explicit `SEARCH_PROVIDER` wins; else if `SEARXNG_URL` is set we assume a
 * self-host running SearXNG; else `brave`. A self-hoster therefore gets keyless
 * search just by pointing `SEARXNG_URL` at their instance; Cloud stays on Brave.
 */

export interface SearchProviderConfig {
  name: SearchProviderName;
  /** Required when name === 'brave'. */
  braveApiKey?: string;
  /** Required when name === 'searxng'. The instance base URL. */
  searxngUrl?: string;
  /** Optional bearer token gating the SearXNG instance. */
  searxngToken?: string;
}

/** Construct the provider described by `config`. */
export function createSearchProvider(
  config: SearchProviderConfig,
): SearchProvider {
  switch (config.name) {
    case 'brave':
      return new BraveSearchProvider({ apiKey: config.braveApiKey });
    case 'searxng':
      if (!config.searxngUrl) {
        throw new SearchProviderError(
          'SEARCH_PROVIDER=searxng requires SEARXNG_URL to be set',
          'searxng',
        );
      }
      return new SearxngSearchProvider({
        baseUrl: config.searxngUrl,
        authToken: config.searxngToken,
      });
    default:
      // Exhaustive over SearchProviderName: a new union member without a case
      // here is a compile error. The runtime throw guards a value that slipped
      // past the type system (e.g. a typo'd SEARCH_PROVIDER env value).
      return assertUnknownSearchProvider(config.name);
  }
}

/** Resolve a config from environment variables (default: see module docs). */
export function resolveSearchProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): SearchProviderConfig {
  const raw = env.SEARCH_PROVIDER?.trim().toLowerCase();
  const searxngUrl = env.SEARXNG_URL?.trim() || undefined;
  // Explicit override wins; else infer from whether a SearXNG instance is wired;
  // else Brave. A non-empty unknown value surfaces as a clear error at
  // construction rather than silently falling back.
  const name = (raw ? raw : searxngUrl ? 'searxng' : 'brave') as SearchProviderName;
  return {
    name,
    braveApiKey: env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    searxngUrl,
    searxngToken: env.SEARXNG_AUTH_TOKEN?.trim() || undefined,
  };
}

/** Build the env-configured provider. The `web_search` tool's lazy default. */
export function searchProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SearchProvider {
  return createSearchProvider(resolveSearchProviderConfig(env));
}

function assertUnknownSearchProvider(name: never): never {
  throw new SearchProviderError(
    `Unknown or unconfigured search provider: "${String(name)}"`,
    String(name),
  );
}
