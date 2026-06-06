import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderName,
} from './search-provider';
import { SearxngSearchProvider } from './providers/searxng.provider';

/**
 * Search provider registry — mirrors the LLM + content provider registries.
 *
 * A thin, exhaustive switch from a `SearchProviderName` to a concrete
 * `SearchProvider`. Adding a provider = adding a case here + its class; the
 * `never` exhaustiveness check makes a forgotten case a compile error.
 *
 * SearXNG (self-hosted, keyless) is the only backend — search is keyless across
 * both self-host and Cloud. The only configuration is `SEARXNG_URL` (the
 * instance base URL); `./dev.sh` starts the sidecar and exports it locally.
 * See docs/plans/search-provider-abstraction.md §6.
 */

export interface SearchProviderConfig {
  name: SearchProviderName;
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
    case 'searxng':
      if (!config.searxngUrl) {
        throw new SearchProviderError(
          'Search requires SEARXNG_URL to be set (run ./dev.sh to start the ' +
            'SearXNG sidecar, or point SEARXNG_URL at your instance)',
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

/** Resolve a config from environment variables. SearXNG is the only provider;
 *  `SEARCH_PROVIDER` is honoured only to surface a typo'd value as a loud error
 *  rather than silently ignoring it. */
export function resolveSearchProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): SearchProviderConfig {
  const raw = env.SEARCH_PROVIDER?.trim().toLowerCase();
  // SearXNG is the only backend. An explicit non-searxng value is preserved so
  // construction throws a clear error instead of pretending it was honoured.
  const name = (raw ? raw : 'searxng') as SearchProviderName;
  return {
    name,
    searxngUrl: env.SEARXNG_URL?.trim() || undefined,
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
