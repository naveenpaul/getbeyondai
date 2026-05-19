import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E integration test for the Researcher async demo path (T4c + T4d).
 *
 * Mocks: Anthropic SDK at the module boundary (scripted tool_use turns),
 * fetch() at the global (scripted Brave + page responses). DB is real.
 *
 * The flow we're proving (async/worker pattern):
 *   POST /teammates/researcher/run { orgId, target }
 *     → 202 { runId, status: 'running' }
 *     → pg-boss enqueues job
 *     → ResearcherWorker picks it up
 *     → loop: brave_search → fetch_url (Citation persisted) → emit_draft
 *     → AgentRun transitions to status=completed, Draft + Claims persisted
 *   GET /teammates/researcher/runs/:id?orgId=
 *     → 200 with full snapshot incl. draft + claims w/ citation URLs
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
import type { ResearcherRunStatusResponse } from './researcher.dto';

const DATABASE_URL = process.env.DATABASE_URL;
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

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
  'ResearcherController (integration, async)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let orgA: string;
    let orgB: string;
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
      const o1 = await prisma.organization.create({ data: { name: 'OrgA' } });
      const o2 = await prisma.organization.create({ data: { name: 'OrgB' } });
      orgA = o1.id;
      orgB = o2.id;
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

    async function pollUntilDone(
      runId: string,
      orgId: string,
    ): Promise<ResearcherRunStatusResponse> {
      const start = Date.now();
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        const res = await app.inject({
          method: 'GET',
          url: `/teammates/researcher/runs/${runId}?orgId=${orgId}`,
        });
        if (res.statusCode === 200) {
          const body = res.json() as ResearcherRunStatusResponse;
          if (body.status !== 'running') return body;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      throw new Error(
        `AgentRun ${runId} did not terminate in ${POLL_TIMEOUT_MS}ms`,
      );
    }

    // ─── POST /run + GET /runs/:id — happy path ──────────────────────

    it('POST returns 202 + runId immediately, GET polls to completed draft', async () => {
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

      mockAnthropicCreate
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock('brave_search', { query: 'Acme dental SaaS' }, 'tu-1'),
            ],
          }),
        )
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock('fetch_url', { url: 'https://acme.example/about' }, 'tu-2'),
            ],
          }),
        )
        .mockImplementationOnce(async () => {
          const cit = await prisma.citation.findFirst({
            where: { url: 'https://acme.example/about' },
          });
          if (!cit) throw new Error('test: expected Citation by now');
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
                      citationId: cit.id,
                    },
                    {
                      text: 'Acme raised $5M Series A in March 2026.',
                      citationId: cit.id,
                    },
                  ],
                },
                'tu-3',
              ),
            ],
          });
        });

      const enqueueRes = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: {
          orgId: orgA,
          triggeredBy: 'usr_test',
          target: 'Acme dental SaaS',
        },
        headers: { 'content-type': 'application/json' },
      });
      expect(enqueueRes.statusCode).toBe(202);
      const enqueue = enqueueRes.json() as {
        runId: string;
        status: 'running';
      };
      expect(enqueue.status).toBe('running');
      expect(enqueue.runId).toBeTruthy();

      // The worker hasn't necessarily run yet — initial poll might still show running.
      const finalState = await pollUntilDone(enqueue.runId, orgA);
      expect(finalState.status).toBe('completed');
      expect(finalState.runId).toBe(enqueue.runId);
      expect(finalState.completedAt).toBeTruthy();
      expect(finalState.toolCallCount).toBe(3);
      expect(finalState.costCents).toBeGreaterThan(0);

      expect(finalState.draft).not.toBeNull();
      expect(finalState.draft?.type).toBe('research_brief');
      expect(finalState.draft?.claims).toHaveLength(2);
      // Each claim carries the citationUrl joined from Citation.
      for (const c of finalState.draft!.claims) {
        expect(c.citationUrl).toBe('https://acme.example/about');
      }
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
                    { text: 'hallucinated fact', citationId: null },
                  ],
                },
                'tu-2',
              ),
            ],
          });
        });

      const enqueueRes = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: orgA, triggeredBy: 'u', target: 'x' },
        headers: { 'content-type': 'application/json' },
      });
      expect(enqueueRes.statusCode).toBe(202);
      const { runId } = enqueueRes.json() as { runId: string };
      const finalState = await pollUntilDone(runId, orgA);

      expect(finalState.status).toBe('completed');
      expect(finalState.draft?.claims).toHaveLength(1);
      expect(finalState.draft?.claims[0]?.text).toBe('cited fact');
    });

    it('all-uncited emit_draft → loop exhausts maxToolCalls → abstained', async () => {
      scriptFetch([() => null]);
      mockAnthropicCreate.mockResolvedValue(
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

      const enqueueRes = await app.inject({
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
      const { runId } = enqueueRes.json() as { runId: string };
      const finalState = await pollUntilDone(runId, orgA);
      expect(finalState.status).toBe('abstained');
      expect(finalState.draft).toBeNull();
      expect(await prisma.draft.count()).toBe(0);
    });

    // ─── POST /run — validation ──────────────────────────────────────

    it('unknown orgId → 404 (no AgentRun created, no job enqueued)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: 'missing-org', triggeredBy: 'u', target: 'x' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(404);
      expect(await prisma.agentRun.count()).toBe(0);
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

    // ─── GET /runs/:id — tenant guards + missing rows ───────────────

    it('GET /runs/:id without orgId → 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/teammates/researcher/runs/anything',
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /runs/:id with unknown id → 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/researcher/runs/does-not-exist?orgId=${orgA}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /runs/:id refuses cross-org access → 403', async () => {
      const run = await prisma.agentRun.create({
        data: {
          orgId: orgA,
          teammate: 'researcher',
          triggeredBy: 'u',
          status: 'completed',
          inputContext: {},
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/researcher/runs/${run.id}?orgId=${orgB}`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /runs/:id returns running status with null draft while in progress', async () => {
      const run = await prisma.agentRun.create({
        data: {
          orgId: orgA,
          teammate: 'researcher',
          triggeredBy: 'u',
          status: 'running',
          inputContext: { target: 'x' },
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/researcher/runs/${run.id}?orgId=${orgA}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ResearcherRunStatusResponse;
      expect(body.status).toBe('running');
      expect(body.draft).toBeNull();
      expect(body.completedAt).toBeNull();
      expect(body.toolCallCount).toBe(0);
    });

    // ─── Audit log persisted across the async hop ────────────────────

    it('ModelCall + ToolCall rows persisted under the AgentRun even when run abstains', async () => {
      scriptFetch([
        (url) =>
          url.startsWith('https://api.search.brave.com')
            ? jsonResponse({ web: { results: [] } })
            : null,
      ]);
      mockAnthropicCreate
        .mockResolvedValueOnce(
          fakeMessage({
            content: [toolUseBlock('brave_search', { query: 'x' }, 'tu-1')],
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

      const enqueueRes = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { orgId: orgA, triggeredBy: 'u', target: 'unknown' },
        headers: { 'content-type': 'application/json' },
      });
      const { runId } = enqueueRes.json() as { runId: string };
      const finalState = await pollUntilDone(runId, orgA);
      expect(finalState.status).toBe('completed');

      const modelCalls = await prisma.modelCall.findMany({ where: { runId } });
      expect(modelCalls.length).toBeGreaterThanOrEqual(2);
      const toolCalls = await prisma.toolCall.findMany({
        where: { runId },
        orderBy: { toolSeq: 'asc' },
      });
      expect(toolCalls.map((t) => t.toolName)).toEqual([
        'brave_search',
        'emit_draft',
      ]);
      expect(finalState.toolCallCount).toBe(2);
    });
  },
);
