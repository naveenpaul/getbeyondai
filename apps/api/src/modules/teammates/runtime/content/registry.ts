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
 * Default resolution (mirrors the search registry's `SEARXNG_URL` inference):
 * an explicit `CONTENT_PROVIDER` wins; else if `CRAWL4AI_URL` is set we assume
 * the sidecar is running and use `crawl4ai`; else `local`. `./dev.sh` starts the
 * crawl4ai sidecar and exports `CRAWL4AI_URL`, so dev gets browser-rendered
 * extraction with no `.env` edit — while a plain `docker compose up` self-host
 * (no `CRAWL4AI_URL`) stays on the zero-dependency `local` extractor.
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
  const crawl4aiUrl = env.CRAWL4AI_URL?.trim() || undefined;
  // Explicit CONTENT_PROVIDER wins; else infer crawl4ai when its sidecar URL is
  // wired (dev.sh exports it on a healthy start); else the zero-dependency local
  // extractor. A non-empty unknown CONTENT_PROVIDER surfaces as a clear error at
  // construction rather than silently falling back.
  const name = (
    raw ? raw : crawl4aiUrl ? 'crawl4ai' : 'local'
  ) as ContentProviderName;
  return {
    name,
    jinaUrl: env.JINA_READER_URL?.trim() || undefined,
    jinaToken: env.JINA_API_KEY?.trim() || undefined,
    crawl4aiUrl,
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
