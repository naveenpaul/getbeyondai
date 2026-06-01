import { z } from 'zod';
import type { AgentTool, ToolContext } from '../agent-tool';
import type { ContentProvider } from '../content/content-provider';
import { contentProviderFromEnv } from '../content/registry';

/**
 * fetch_url — fetch + extract readable text from a URL (T4b.2).
 *
 * Side effect: persists a `Citation` row pointing at the fetched URL with
 * a snippet of the extracted text. The returned payload includes the
 * Citation.id so the model can reference it in subsequent emit_draft calls.
 *
 * This is the load-bearing link in the trust chain: a claim CAN be cited
 * iff fetch_url was called on the source first. Drafts can't reference a
 * URL the model never actually loaded.
 *
 * The fetch + extraction is delegated to a swappable `ContentProvider`
 * (`local` regex strip by default, `crawl4ai` for browser-rendered markdown —
 * `CONTENT_PROVIDER` env). This tool owns the parts that must NOT change when
 * the extractor swaps: creating the Citation row, the 8 KB excerpt cap (lets
 * the model fit dozens of citations in one context window), and the
 * tool_result output shape.
 */

export const FetchUrlInputSchema = z.object({
  url: z.string().url(),
});

export interface FetchUrlOutput {
  /** The Citation row's id — pass this back as citationId on emit_draft claims. */
  citationId: string;
  url: string;
  title: string | null;
  /** Cleaned text excerpt (max 8 KB). */
  excerpt: string;
  status: number;
  contentType: string | null;
}

export interface FetchUrlDeps {
  /**
   * Extractor. Defaults to the env-configured provider, resolved lazily on
   * first use so module import neither reads env nor throws on a misconfigured
   * (e.g. crawl4ai-without-URL) setup. Tests inject a fake.
   */
  contentProvider?: ContentProvider;
  /** Soft cap on extracted text length in characters. */
  maxTextLength?: number;
}

const DEFAULT_MAX_TEXT = 8 * 1024;

export function buildFetchUrlTool(deps: FetchUrlDeps = {}): AgentTool {
  const maxTextLength = deps.maxTextLength ?? DEFAULT_MAX_TEXT;
  // Resolve the provider lazily + memoize: the default singleton is built at
  // module load, but we don't want to read env / risk a config throw until the
  // tool is actually used.
  let provider = deps.contentProvider;
  const getProvider = (): ContentProvider => {
    if (!provider) provider = contentProviderFromEnv();
    return provider;
  };

  return {
    name: 'fetch_url',
    description:
      'Fetch a URL and extract readable text. Returns { citationId, url, ' +
      'title, excerpt, status }. The returned citationId can be used on ' +
      'emit_draft claims to source factual statements. Always fetch a URL ' +
      'before citing it — claims pointing at unfetched URLs are dropped.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri' } },
    },
    async execute(args: unknown, ctx: ToolContext): Promise<FetchUrlOutput> {
      const parsed = FetchUrlInputSchema.parse(args);
      const fetched = await getProvider().fetch(parsed.url);
      const excerpt = fetched.text.slice(0, maxTextLength);

      const citation = await ctx.prisma.citation.create({
        data: {
          runId: ctx.runId,
          url: parsed.url,
          title: fetched.title,
          excerpt,
        },
      });

      return {
        citationId: citation.id,
        url: parsed.url,
        title: fetched.title,
        excerpt,
        status: fetched.status,
        contentType: fetched.contentType,
      };
    },
  };
}

/** Default singleton — wired from RuntimeModule. Uses the env-configured provider. */
export const fetchUrlTool = buildFetchUrlTool();
