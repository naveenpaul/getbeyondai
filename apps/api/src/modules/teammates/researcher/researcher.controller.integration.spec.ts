import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E integration test for the Researcher async demo path (T4c → T4d → T7).
 *
 * Mocks: Anthropic SDK at the module boundary, fetch() at the global. DB
 * is real. Each test mints a real session via the magic-link flow (see
 * createTestSession) — the auto-created Organization becomes the test's
 * tenant. Cross-org tests sign in TWO emails for two orgs.
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
import { createAuth } from '../../auth/auth.config';
import { createTestSession } from '../../auth/test-session';
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
  'ResearcherController (integration, async, session-auth)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let auth: ReturnType<typeof createAuth>;
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
      process.env.AUTH_SECRET = 'test-auth-secret-32-chars-padding-to-match';

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
      auth = createAuth(prisma);
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
          voices, company_brains, sessions, accounts, verifications, org_memberships,
          users, organizations
        RESTART IDENTITY CASCADE
      `);
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE pgboss.job, pgboss.archive RESTART IDENTITY`,
        )
        .catch(() => {});
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
      cookie: string,
    ): Promise<ResearcherRunStatusResponse> {
      const start = Date.now();
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        const res = await app.inject({
          method: 'GET',
          url: `/teammates/researcher/runs/${runId}`,
          headers: { cookie },
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
      const { cookie } = await createTestSession(prisma, auth, 'alice@test.com');
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
                  },
                  claims: [
                    {
                      text: 'Acme makes SaaS for dental practices.',
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
        payload: { target: 'Acme dental SaaS' },
        headers: { cookie, 'content-type': 'application/json' },
      });
      expect(enqueueRes.statusCode).toBe(202);
      const enqueue = enqueueRes.json() as {
        runId: string;
        status: 'running';
      };
      expect(enqueue.status).toBe('running');
      expect(enqueue.runId).toBeTruthy();

      const finalState = await pollUntilDone(enqueue.runId, cookie);
      expect(finalState.status).toBe('completed');
      expect(finalState.completedAt).toBeTruthy();
      expect(finalState.draft).not.toBeNull();
      expect(finalState.draft?.claims[0]?.citationUrl).toBe(
        'https://acme.example/about',
      );
    });

    it('all-uncited emit_draft → loop exhausts maxToolCalls → abstained', async () => {
      const { cookie } = await createTestSession(prisma, auth, 'alice@test.com');
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
        payload: { target: 'will-fail', budgetCents: 1000 },
        headers: { cookie, 'content-type': 'application/json' },
      });
      const { runId } = enqueueRes.json() as { runId: string };
      const finalState = await pollUntilDone(runId, cookie);
      expect(finalState.status).toBe('abstained');
      expect(finalState.draft).toBeNull();
      expect(await prisma.draft.count()).toBe(0);
    });

    // ─── Auth + tenant guards ────────────────────────────────────────

    it('no session → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: { target: 'x' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('missing target → 400', async () => {
      const { cookie } = await createTestSession(prisma, auth, 'alice@test.com');
      const res = await app.inject({
        method: 'POST',
        url: '/teammates/researcher/run',
        payload: {},
        headers: { cookie, 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('body cannot override session orgId (identity comes from cookie)', async () => {
      // Alice tries to spoof a different org in the body — ignored. The
      // run lands on alice's org, not whatever she pasted.
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      scriptFetch([() => null]);
      mockAnthropicCreate.mockResolvedValue(
        fakeMessage({
          content: [
            toolUseBlock(
              'emit_draft',
              {
                type: 'research_brief',
                content: { headline: 'x' },
                claims: [{ text: 'x', citationId: null, abstained: true }],
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
          target: 'x',
          // Legacy fields ignored by the controller — body schema doesn't
          // accept them anymore but extra fields would just be dropped.
          orgId: 'spoofed-org',
          triggeredBy: 'spoofed-user',
        },
        headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      });
      // The body schema is strict: extra props are stripped (Zod default).
      expect(res.statusCode).toBe(202);
      const { runId } = res.json() as { runId: string };
      const run = await prisma.agentRun.findUnique({ where: { id: runId } });
      expect(run?.orgId).toBe(alice.orgId);
      expect(run?.triggeredBy).toBe(alice.userId);
    });

    // ─── GET /runs/:id — tenant guards ──────────────────────────────

    it('GET /runs/:id refuses cross-org access → 403', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      const bob = await createTestSession(prisma, auth, 'bob@test.com');
      // Alice creates a run in her org.
      const run = await prisma.agentRun.create({
        data: {
          orgId: alice.orgId,
          teammate: 'researcher',
          triggeredBy: alice.userId,
          status: 'completed',
          inputContext: {},
        },
      });
      // Bob tries to read it.
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/researcher/runs/${run.id}`,
        headers: { cookie: bob.cookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /runs/:id returns running status with null draft while in progress', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      const run = await prisma.agentRun.create({
        data: {
          orgId: alice.orgId,
          teammate: 'researcher',
          triggeredBy: alice.userId,
          status: 'running',
          inputContext: { target: 'x' },
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/researcher/runs/${run.id}`,
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ResearcherRunStatusResponse;
      expect(body.status).toBe('running');
      expect(body.draft).toBeNull();
    });

    it('GET /runs/:id with unknown id → 404', async () => {
      const { cookie } = await createTestSession(prisma, auth, 'alice@test.com');
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/researcher/runs/does-not-exist`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    // ─── Audit log persisted across the async hop ────────────────────

    it('ModelCall + ToolCall rows persisted under the AgentRun', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
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
        payload: { target: 'unknown' },
        headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      });
      const { runId } = enqueueRes.json() as { runId: string };
      const finalState = await pollUntilDone(runId, alice.cookie);
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
