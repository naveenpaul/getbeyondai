import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration test for the SSE progress stream (T4e.5).
 *
 * inject() can't be used here — SSE keeps the connection open until the
 * runtime sends a terminal event. We listen on a random port and use Node's
 * native fetch + ReadableStream to consume the stream chunk-by-chunk.
 *
 * Mocks: Anthropic SDK at the module boundary, fetch at the global. Real
 * Postgres. Real pg-boss (the worker actually picks up the job).
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

const DATABASE_URL = process.env.DATABASE_URL;
const STREAM_DEADLINE_MS = 15_000;

function fakeMessage(opts: {
  content: Anthropic.ContentBlock[];
}): Anthropic.Message {
  return {
    id: `msg-${Math.random()}`,
    type: 'message',
    role: 'assistant',
    content: opts.content,
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function toolUseBlock(
  name: string,
  input: unknown,
  id = `tu-${Math.random()}`,
): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock;
}

interface ParsedEvent {
  type: string;
  data: unknown;
}

/**
 * Parse SSE chunks off a ReadableStream. Resolves when a terminal event is
 * received OR the deadline trips. Returns ALL parsed events in order.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  isTerminal: (event: ParsedEvent) => boolean,
  deadlineMs: number,
): Promise<ParsedEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE messages are separated by a blank line.
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseChunk(raw);
        if (parsed) {
          events.push(parsed);
          if (isTerminal(parsed)) return events;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

function parseSseChunk(raw: string): ParsedEvent | null {
  let type = 'message';
  let dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  try {
    return { type, data: JSON.parse(dataStr) };
  } catch {
    return { type, data: dataStr };
  }
}

describe.skipIf(!DATABASE_URL)(
  'Researcher SSE stream (integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let auth: ReturnType<typeof createAuth>;
    let baseUrl: string;
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
      // Listen on a random port so multiple integration suites can run in parallel later.
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      if (!address || typeof address === 'string') {
        throw new Error('Could not determine listening address');
      }
      baseUrl = `http://127.0.0.1:${address.port}`;

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
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        // Don't intercept the stream request to our own server.
        if (url.startsWith(baseUrl)) return originalFetch(input, init);
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

    it('streams the full event sequence end-to-end', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      scriptFetch([
        (url) =>
          url.startsWith('https://api.search.brave.com')
            ? jsonResponse({
                web: {
                  results: [
                    { title: 'Acme', url: 'https://acme.example' },
                  ],
                },
              })
            : null,
        (url) =>
          url === 'https://acme.example'
            ? htmlResponse(
                '<html><head><title>Acme</title></head><body>Founded 2022. $5M Series A.</body></html>',
              )
            : null,
      ]);

      mockAnthropicCreate
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock('brave_search', { query: 'Acme' }, 'tu-1'),
            ],
          }),
        )
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock('fetch_url', { url: 'https://acme.example' }, 'tu-2'),
            ],
          }),
        )
        .mockImplementationOnce(async () => {
          const cit = await prisma.citation.findFirst({
            where: { url: 'https://acme.example' },
          });
          return fakeMessage({
            content: [
              toolUseBlock(
                'emit_draft',
                {
                  type: 'research_brief',
                  content: { headline: 'Acme' },
                  claims: [
                    { text: 'Founded 2022.', citationId: cit?.id ?? '' },
                  ],
                },
                'tu-3',
              ),
            ],
          });
        });

      // Enqueue the run via real fetch (the SSE test consumes streams; the
      // POST is just a normal JSON request).
      const enqueueRes = await originalFetch(
        `${baseUrl}/teammates/researcher/run`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: alice.cookie,
          },
          body: JSON.stringify({ target: 'Acme' }),
        },
      );
      expect(enqueueRes.status).toBe(202);
      const { runId } = (await enqueueRes.json()) as { runId: string };

      // Open the stream IMMEDIATELY (worker may not have picked up the job yet).
      const streamRes = await originalFetch(
        `${baseUrl}/teammates/researcher/runs/${runId}/stream`,
        { headers: { accept: 'text/event-stream', cookie: alice.cookie } },
      );
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
      const events = await consumeStream(
        streamRes.body!,
        (e) =>
          e.type === 'run_completed' ||
          e.type === 'run_abstained' ||
          e.type === 'run_failed',
        STREAM_DEADLINE_MS,
      );

      const types = events.map((e) => e.type);
      // The exact ordering is loop-driven; verify the key landmarks are present.
      expect(types).toContain('model_call_started');
      expect(types).toContain('model_call_completed');
      expect(types).toContain('tool_call_started');
      expect(types).toContain('tool_call_completed');
      expect(types).toContain('draft_emitted');
      expect(types[types.length - 1]).toBe('run_completed');

      // The final event's data carries the runId + draftId.
      const last = events.at(-1)!;
      const lastData = last.data as {
        runId: string;
        data: { draftId: string };
      };
      expect(lastData.runId).toBe(runId);
      expect(lastData.data.draftId).toBeTruthy();
    });

    it('mid-run connect replays buffered events from the bus', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      // Two-turn run; the test waits 50 ms before opening the stream to
      // give the worker a head start.
      scriptFetch([
        (url) =>
          url.startsWith('https://api.search.brave.com')
            ? jsonResponse({ web: { results: [] } })
            : null,
      ]);

      mockAnthropicCreate
        .mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 80));
          return fakeMessage({
            content: [toolUseBlock('brave_search', { query: 'x' }, 'tu-1')],
          });
        })
        .mockResolvedValueOnce(
          fakeMessage({
            content: [
              toolUseBlock(
                'emit_draft',
                {
                  type: 'research_brief',
                  content: {},
                  claims: [
                    { text: 'no signal', citationId: null, abstained: true },
                  ],
                },
                'tu-2',
              ),
            ],
          }),
        );

      const enqueueRes = await originalFetch(
        `${baseUrl}/teammates/researcher/run`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: alice.cookie,
          },
          body: JSON.stringify({ target: 'x' }),
        },
      );
      const { runId } = (await enqueueRes.json()) as { runId: string };

      // Wait briefly so at least the first model_call_started lands in the buffer.
      await new Promise((r) => setTimeout(r, 30));

      const streamRes = await originalFetch(
        `${baseUrl}/teammates/researcher/runs/${runId}/stream`,
        { headers: { cookie: alice.cookie } },
      );
      const events = await consumeStream(
        streamRes.body!,
        (e) =>
          e.type === 'run_completed' ||
          e.type === 'run_abstained' ||
          e.type === 'run_failed',
        STREAM_DEADLINE_MS,
      );
      const types = events.map((e) => e.type);
      // The first model_call_started arrived before we connected; the
      // replay should still surface it.
      expect(types.indexOf('model_call_started')).toBe(0);
      expect(types[types.length - 1]).toBe('run_completed');
    });

    it('unknown run id → 404 (stream never opens)', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      const res = await originalFetch(
        `${baseUrl}/teammates/researcher/runs/does-not-exist/stream`,
        { headers: { cookie: alice.cookie } },
      );
      expect(res.status).toBe(404);
    });

    it('cross-org access → 403', async () => {
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      const bob = await createTestSession(prisma, auth, 'bob@test.com');
      // Alice's run, Bob's session.
      const run = await prisma.agentRun.create({
        data: {
          orgId: alice.orgId,
          teammate: 'researcher',
          triggeredBy: alice.userId,
          status: 'running',
          inputContext: {},
        },
      });
      const res = await originalFetch(
        `${baseUrl}/teammates/researcher/runs/${run.id}/stream`,
        { headers: { cookie: bob.cookie } },
      );
      expect(res.status).toBe(403);
    });

    it('no session → 401', async () => {
      const res = await originalFetch(
        `${baseUrl}/teammates/researcher/runs/anything/stream`,
      );
      expect(res.status).toBe(401);
    });

    it('already-terminal run → synthesizes a terminal event + closes', async () => {
      // The bus only buffers events for 60s after terminal. If the user
      // connects 30 min later, the snapshot is empty. The endpoint should
      // synthesize a terminal event from the DB row so the client doesn't
      // hang forever.
      const alice = await createTestSession(prisma, auth, 'alice@test.com');
      const run = await prisma.agentRun.create({
        data: {
          orgId: alice.orgId,
          teammate: 'researcher',
          triggeredBy: alice.userId,
          status: 'completed',
          completedAt: new Date(),
          inputContext: {},
        },
      });
      const streamRes = await originalFetch(
        `${baseUrl}/teammates/researcher/runs/${run.id}/stream`,
        { headers: { cookie: alice.cookie } },
      );
      expect(streamRes.status).toBe(200);
      const events = await consumeStream(
        streamRes.body!,
        (e) =>
          e.type === 'run_completed' ||
          e.type === 'run_abstained' ||
          e.type === 'run_failed',
        STREAM_DEADLINE_MS,
      );
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1]?.type).toBe('run_completed');
    });
  },
);
