import {
  ContentProviderError,
  type ContentProvider,
  type ContentProviderName,
} from './content-provider';
import { LocalExtractProvider } from './providers/local-extract.provider';
import { JinaReaderProvider } from './providers/jina-reader.provider';
import { Crawl4aiProvider } from './providers/crawl4ai.provider';

/**
 * Content provider registry — mirrors the LLM provider registry (P2).
 *
 * A thin, exhaustive switch from a `ContentProviderName` to a concrete
 * `ContentProvider`. Adding a provider = adding a case here + its class; the
 * `never` exhaustiveness check makes a forgotten case a compile error.
 *
 * `local` is the default everywhere — it needs no extra service, so a
 * self-hoster gets working research out of the box. `crawl4ai` is the opt-in
 * upgrade and requires `CRAWL4AI_URL` to point at the sidecar.
 */

export interface ContentProviderConfig {
  name: ContentProviderName;
  /** Optional override for the Jina Reader base URL (else the hosted default). */
  jinaUrl?: string;
  /** Optional Jina API key (higher rate limits). */
  jinaToken?: string;
  /** Required when name === 'crawl4ai'. The sidecar REST base URL. */
  crawl4aiUrl?: string;
  /** Optional bearer token gating the Crawl4AI endpoint. */
  crawl4aiToken?: string;
}

/** Construct the provider described by `config`. */
export function createContentProvider(
  config: ContentProviderConfig,
): ContentProvider {
  switch (config.name) {
    case 'local':
      return new LocalExtractProvider();
    case 'jina':
      // No required config — the hosted r.jina.ai default works key-less.
      return new JinaReaderProvider({
        baseUrl: config.jinaUrl,
        apiKey: config.jinaToken,
      });
    case 'crawl4ai':
      if (!config.crawl4aiUrl) {
        throw new ContentProviderError(
          'CONTENT_PROVIDER=crawl4ai requires CRAWL4AI_URL to be set',
          'crawl4ai',
        );
      }
      return new Crawl4aiProvider({
        baseUrl: config.crawl4aiUrl,
        apiToken: config.crawl4aiToken,
      });
    default:
      // Exhaustive over ContentProviderName: a new union member without a case
      // here is a compile error. The runtime throw guards a value that slipped
      // past the type system (e.g. a typo'd CONTENT_PROVIDER env value).
      return assertUnknownContentProvider(config.name);
  }
}

/** Resolve a config from environment variables (default: local). */
export function resolveContentProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContentProviderConfig {
  const raw = env.CONTENT_PROVIDER?.trim().toLowerCase();
  // Empty / unset → the safe default. A non-empty unknown value is surfaced as
  // a clear error at construction rather than silently falling back, so a
  // misconfigured self-host fails loudly instead of quietly using the wrong
  // extractor.
  const name = (raw ? raw : 'local') as ContentProviderName;
  return {
    name,
    jinaUrl: env.JINA_READER_URL?.trim() || undefined,
    jinaToken: env.JINA_API_KEY?.trim() || undefined,
    crawl4aiUrl: env.CRAWL4AI_URL?.trim() || undefined,
    crawl4aiToken: env.CRAWL4AI_API_TOKEN?.trim() || undefined,
  };
}

/** Build the env-configured provider. The `fetch_url` tool's lazy default. */
export function contentProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ContentProvider {
  return createContentProvider(resolveContentProviderConfig(env));
}

function assertUnknownContentProvider(name: never): never {
  throw new ContentProviderError(
    `Unknown or unconfigured content provider: "${String(name)}"`,
    String(name),
  );
}
