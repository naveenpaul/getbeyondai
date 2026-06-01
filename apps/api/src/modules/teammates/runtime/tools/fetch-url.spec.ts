import { describe, expect, it, vi } from 'vitest';
import { buildFetchUrlTool, type FetchUrlOutput } from './fetch-url';
import type { AgentTool, ToolContext } from '../agent-tool';
import type { ContentProvider, FetchedContent } from '../content/content-provider';

/**
 * fetch_url tool tests.
 *
 * This tool owns the trust-chain contract: it delegates fetch + extraction to
 * a ContentProvider, then (a) applies the excerpt cap, (b) creates the Citation
 * row, and (c) returns the fixed output shape. Extraction correctness lives in
 * the provider specs; here we test the contract against a fake provider.
 */

async function runFetch(
  tool: AgentTool,
  args: { url: string },
  ctx: ToolContext,
): Promise<FetchUrlOutput> {
  return tool.execute(args, ctx) as Promise<FetchUrlOutput>;
}

/** A ContentProvider that returns canned content (and records the urls it saw). */
function fakeProvider(
  content: Partial<FetchedContent> = {},
): ContentProvider & { urls: string[] } {
  const urls: string[] = [];
  return {
    name: 'fake',
    urls,
    async fetch(url: string): Promise<FetchedContent> {
      urls.push(url);
      return {
        // `in` checks (not ??) so an explicitly-passed null is honored.
        title: 'title' in content ? (content.title ?? null) : 'Default Title',
        text: content.text ?? 'default extracted text',
        status: content.status ?? 200,
        contentType: content.contentType ?? 'text/html',
      };
    },
  };
}

interface FakeCitation {
  id: string;
  runId: string;
  url: string;
  title: string | null;
  excerpt: string;
}

function makeCtx(): { ctx: ToolContext; citations: FakeCitation[] } {
  const citations: FakeCitation[] = [];
  let counter = 0;
  const ctx: ToolContext = {
    runId: 'run-1',
    orgId: 'org-A',
    prisma: {
      citation: {
        create: vi.fn(
          async ({ data }: { data: Omit<FakeCitation, 'id'> }) => {
            const row: FakeCitation = { id: `cit-${++counter}`, ...data };
            citations.push(row);
            return row;
          },
        ),
      },
    } as never,
  };
  return { ctx, citations };
}

describe('fetch_url', () => {
  it('delegates to the provider and creates a Citation with the extracted content', async () => {
    const provider = fakeProvider({
      title: 'Acme Inc — homepage',
      text: 'Welcome to Acme. We are a SaaS startup.',
      status: 200,
      contentType: 'text/html',
    });
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ contentProvider: provider });

    const result = await runFetch(tool, { url: 'https://acme.com' }, ctx);

    expect(provider.urls).toEqual(['https://acme.com']);
    expect(result).toMatchObject({
      citationId: 'cit-1',
      url: 'https://acme.com',
      title: 'Acme Inc — homepage',
      excerpt: 'Welcome to Acme. We are a SaaS startup.',
      status: 200,
      contentType: 'text/html',
    });

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      runId: 'run-1',
      url: 'https://acme.com',
      title: 'Acme Inc — homepage',
      excerpt: 'Welcome to Acme. We are a SaaS startup.',
    });
  });

  it('caps the excerpt to maxTextLength (Citation + output both capped)', async () => {
    const provider = fakeProvider({ text: 'word '.repeat(10_000) });
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({
      contentProvider: provider,
      maxTextLength: 100,
    });

    const result = await runFetch(tool, { url: 'https://x.example' }, ctx);
    expect(result.excerpt.length).toBeLessThanOrEqual(100);
    expect(citations[0]?.excerpt.length).toBeLessThanOrEqual(100);
  });

  it('persists a null title (still creating the Citation)', async () => {
    const provider = fakeProvider({ title: null });
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ contentProvider: provider });

    const result = await runFetch(tool, { url: 'https://no-title.example' }, ctx);
    expect(result.title).toBeNull();
    expect(citations[0]?.title).toBeNull();
  });

  it('records the provider-reported status, including 4xx', async () => {
    const provider = fakeProvider({ status: 404, text: 'Not Found' });
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ contentProvider: provider });

    const result = await runFetch(tool, { url: 'https://missing.example' }, ctx);
    expect(result.status).toBe(404);
    // Even on 404 we record the Citation so the audit log shows what was attempted.
    expect(citations).toHaveLength(1);
  });

  it('rejects non-URL input at the Zod boundary (no fetch, no Citation)', async () => {
    const provider = fakeProvider();
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ contentProvider: provider });

    await expect(tool.execute({ url: 'not-a-url' }, ctx)).rejects.toThrow();
    expect(provider.urls).toHaveLength(0);
    expect(citations).toHaveLength(0);
  });

  it('propagates a provider failure (no Citation written)', async () => {
    const failing: ContentProvider = {
      name: 'fake',
      fetch: vi.fn(async () => {
        throw new Error('extraction failed');
      }),
    };
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ contentProvider: failing });

    await expect(
      tool.execute({ url: 'https://boom.example' }, ctx),
    ).rejects.toThrow('extraction failed');
    expect(citations).toHaveLength(0);
  });
});
