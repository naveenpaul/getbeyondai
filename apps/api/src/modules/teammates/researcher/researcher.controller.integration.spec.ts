import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E integration test for the Researcher demo path (T4c).
 *
 * Mocks: Anthropic SDK at the module boundary (scripted tool_use turns),
 * fetch() at the global (scripted Brave + page responses). DB is real.
 *
 * The flow we're proving:
 *   POST /teammates/researcher/run { orgId, target }
 *     → AgentRun created (status=running)
 *     → loop: brave_search → fetch_url (Citation persisted) → emit_draft
 *     → Draft + Claims persisted
 *     → AgentRun status=completed, outputDraftId set
 *     → response: { runId, draftId, costCents, toolCallCount }
 */

const { mockAnthropicCreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    constructor(_opts: { apiKey: string }) {}
    messages = { create: mockAnthropicCreate };
  }
  return { default: FakeAnthropic };
});

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';

const DATABASE_URL = process.env.DATABASE_URL;

function fakeMessage(opts: {
  content: Anthropic.ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
}): Anthropic.Message {
  return {
    id: `msg-${Math.random()}`,
    type: 'message',
    role: 'assistant',
    content: opts.content,
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
    },
  };
}

function toolUseBlock(
  name: string,
  input: unknown,
  id = `tu-${Math.random()}`,
): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock;
}

describe.skipIf(!DATABASE_URL)(
  'ResearcherController (integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let orgA: string;
    let originalFetch: typeof fetch;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}".`,
        );
      }
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
      process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
      // Must be set for CredentialManager (loaded by ConnectorsModule).
      process.env.CREDENTIAL_MASTER_KEY = Buffer.from(
        new Uint8Array(32).fill(7),
      ).toString('base64');

      originalFetch = globalThis.fetch;

      const { AppModule } = await import('../../../app.module');
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
    });

    afterAll(async () => {
      globalThis.fetch = originalFetch;
      if (app) await app.close();
      if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          draft_actions, claims, drafts,
          contact_sources, contact_emails, contact_list_members, contact_lists,
          contacts, sync_runs, oauth_states, connector_accounts,
          tool_calls, model_calls, citations, agent_runs,
          voices, company_brains, users, organizations
        RESTART IDENTITY CASCADE
      `);
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE pgboss.job, pgboss.archive RESTART IDENTITY`,
        )
        .catch(() => {});
      const o = await prisma.organization.create({ data: { name: 'OrgA' } });
      orgA = o.id;
    });

    function scriptFetch(handlers: Array<(url: string) => Response | null>) {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        for (const h of handlers) {
          const resp = h(url);
          if (resp) return resp;
        }
        throw new Error(`fetch fell through for URL: ${url}`);
      }) as typeof fetch;
    }

    function jsonResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    function htmlResponse(html: string): Response {
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    it('happy path: search → fetch → emit_draft → persisted Draft + Claims', async () => {
      // Script the HTTP layer: Brave Search → page fetch.
      scriptFetch([
        (url) =>
          url.startsWith('https://api.search.brave.com')
            ? jsonResponse({
                web: {
                  results: [
                    {
                      title: 'Acme - homepage',
                      url: 'https://acme.example/about',
                      description: 'Acme makes SaaS for dental practices.',
                    },
                  ],
                },
              })
            : null,
        (url) =>
          url === 'https://acme.example/about'
            ? htmlResponse(
                '<html><head><title>Acme — About</title></head><body>' +
                  '<h1>Acme</h1><p>Acme makes SaaS for dental practices. ' +
                  'Founded in 2022. Raised $5M Series A in March 2026.</p>' +
                  '</body></html>',
              )
            : null,
        () => null,
      ]);

      // Script the Anthropic SDK: 3 turns (search → fetch → emit_draft).
      mockAnthropicCreate
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock(
                'brave_search',
                { query: 'Acme dental SaaS' },
                'tu-1',
              ),
            ],
          }),
        )
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock(
                'fetch_url',
                { url: 'https://acme.example/about' },
                'tu-2',
              ),
            ],
          }),
        )
        // The loop will hand us the fetch_url result which includes the
        // citationId. The model must cite it back in emit_draft.
        // To make this test deterministic, we look it up from the DB
        // mid-flight via the implementation factory below.
        .mockImplementationOnce(async () => {
          // Find the Citation row created by the fetch_url tool.
          const citations = await prisma.citation.findMany({
            where: { url: 'https://acme.example/about' },
          });
          const citationId = citations[0]?.id;
          if (!citationId) {
            throw new Error('test setup: expected a Citation row by now');
          }
          return fakeMessage({
            content: [
              toolUseBlock(
                'emit_draft',
                {
                  type: 'research_brief',
                  content: {
                    headline: 'Acme — dental SaaS, Series A',
                    summary:
                      'Acme makes SaaS for dental practices, founded 2022, $5M Series A March 2026.',
                  },
                  claims: [
                    {
                      text: 'Acme makes SaaS for dental practices.',
                      citationId,
                    },
                    {
                      text: 'Acme raised $5M Series A in March 2026.',
                      citationId,
                    },
                  ],
                },
                'tu-3',
              ),
            ],
          });
        });

      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: {
          orgId: orgA,
          triggeredBy: 'usr_test',
          target: 'Acme dental SaaS',
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        runId: string;
        status: string;
        draftId?: string;
        costCents: number;
        toolCallCount: number;
      };
      expect(body.status).toBe('completed');
      expect(body.draftId).toBeTruthy();
      expect(body.toolCallCount).toBe(3);
      expect(body.costCents).toBeGreaterThan(0);

      const run = await prisma.agentRun.findUnique({
        where: { id: body.runId },
      });
      expect(run?.status).toBe('completed');
      expect(run?.outputDraftId).toBe(body.draftId);
      expect(run?.teammate).toBe('researcher');

      const draft = await prisma.draft.findUnique({
        where: { id: body.draftId! },
        include: { claims: true },
      });
      expect(draft?.type).toBe('research_brief');
      expect(draft?.claims).toHaveLength(2);
      // Both claims grounded in a real Citation row.
      const citationIds = draft?.claims.map((c) => c.citationId);
      const cit = await prisma.citation.findFirst({
        where: { url: 'https://acme.example/about' },
      });
      expect(citationIds).toContain(cit?.id);
    });

    it('uncited claim is dropped at persistence; cited siblings survive', async () => {
      scriptFetch([
        (url) =>
          url.startsWith('https://api.search.brave.com')
            ? jsonResponse({ web: { results: [{ url: 'https://x.example' }] } })
            : null,
        (url) =>
          url === 'https://x.example'
            ? htmlResponse('<html><body>Source body</body></html>')
            : null,
      ]);

      mockAnthropicCreate
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock('fetch_url', { url: 'https://x.example' }, 'tu-1'),
            ],
          }),
        )
        .mockImplementationOnce(async () => {
          const cit = await prisma.citation.findFirst({
            where: { url: 'https://x.example' },
          });
          return fakeMessage({
            content: [
              toolUseBlock(
                'emit_draft',
                {
                  type: 'research_brief',
                  content: { headline: 'h' },
                  claims: [
                    { text: 'cited fact', citationId: cit?.id ?? '' },
                    // Uncited + not abstained — must be dropped.
                    { text: 'hallucinated fact', citationId: null },
                  ],
                },
                'tu-2',
              ),
            ],
          });
        });

      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: orgA, triggeredBy: 'u', target: 'x' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { draftId: string };
      const draft = await prisma.draft.findUnique({
        where: { id: body.draftId },
        include: { claims: true },
      });
      // Only the cited claim survived.
      expect(draft?.claims).toHaveLength(1);
      expect(draft?.claims[0]?.text).toBe('cited fact');
    });

    it('all-uncited emit_draft → retry message → model exhausts tool calls → abstained', async () => {
      scriptFetch([() => null]);
      mockAnthropicCreate
        // Three turns all with the same uncited emit_draft attempt
        .mockResolvedValue(
          fakeMessage({
            content: [
              toolUseBlock(
                'emit_draft',
                {
                  type: 'research_brief',
                  content: {},
                  claims: [{ text: 'fact', citationId: null }],
                },
                `tu-${Math.random()}`,
              ),
            ],
          }),
        );

      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: {
          orgId: orgA,
          triggeredBy: 'u',
          target: 'will-fail',
          budgetCents: 1000,
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { status: string; reason?: string };
      expect(body.status).toBe('abstained');
      // No Draft persisted.
      expect(await prisma.draft.count()).toBe(0);
    });

    it('unknown orgId → 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: 'missing-org', triggeredBy: 'u', target: 'x' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('missing target → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: orgA, triggeredBy: 'u' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('persists ModelCall + ToolCall rows for the audit log', async () => {
      scriptFetch([
        (url) =>
          url.startsWith('https://api.search.brave.com')
            ? jsonResponse({ web: { results: [] } })
            : null,
      ]);
      // 1) brave_search (empty results)  2) emit_draft (abstained)
      mockAnthropicCreate
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock('brave_search', { query: 'x' }, 'tu-1'),
            ],
          }),
        )
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock(
                'emit_draft',
                {
                  type: 'research_brief',
                  content: { headline: 'no signal' },
                  claims: [
                    {
                      text: 'No public info found.',
                      citationId: null,
                      abstained: true,
                    },
                  ],
                },
                'tu-2',
              ),
            ],
          }),
        );

      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: orgA, triggeredBy: 'u', target: 'unknown company' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { runId: string; draftId: string };

      const modelCalls = await prisma.modelCall.findMany({
        where: { runId: body.runId },
      });
      expect(modelCalls.length).toBeGreaterThanOrEqual(2);
      const toolCalls = await prisma.toolCall.findMany({
        where: { runId: body.runId },
        orderBy: { toolSeq: 'asc' },
      });
      expect(toolCalls.map((t) => t.toolName)).toEqual([
        'brave_search',
        'emit_draft',
      ]);
      // Cost was accumulated on the AgentRun.
      const run = await prisma.agentRun.findUnique({
        where: { id: body.runId },
      });
      expect(run?.costCents).toBeGreaterThan(0);
    });
  },
);
