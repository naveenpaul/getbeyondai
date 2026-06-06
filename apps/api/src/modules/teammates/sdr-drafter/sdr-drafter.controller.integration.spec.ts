import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E integration test for the SDR Drafter async path (T9.7).
 *
 * Mocks: Anthropic SDK at the module boundary. DB is real. Each test mints
 * a real session via the magic-link flow. The Researcher tests already
 * exercise the runtime end-to-end; here we focus on what's specific to
 * the Drafter: contact resolution, recipient persistence, get_research_brief
 * citation copying, and the cross-tenant boundary.
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
import type { SdrDrafterRunStatusResponse } from './sdr-drafter.dto';

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

describe.skipIf(!DATABASE_URL)('SdrDrafterController (integration)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let auth: Awaited<ReturnType<typeof createAuth>>;
  let alice: { cookie: string; userId: string; orgId: string };

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (!dbName.includes('test')) {
      throw new Error(
        `Integration tests refuse to run against database "${dbName}".`,
      );
    }
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.SEARXNG_URL = 'http://searxng.test';
    process.env.CREDENTIAL_MASTER_KEY = Buffer.from(
      new Uint8Array(32).fill(7),
    ).toString('base64');
    process.env.AUTH_SECRET = 'test-auth-secret-32-chars-padding-to-match';

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
    auth = await createAuth(prisma);
  });

  afterAll(async () => {
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
        voices, company_brains, invites, sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
    await prisma
      .$executeRawUnsafe(
        `TRUNCATE TABLE pgboss.job, pgboss.archive RESTART IDENTITY`,
      )
      .catch(() => {});
    alice = await createTestSession(prisma, auth, 'alice@test.com');
  });

  async function pollUntilDone(
    runId: string,
    cookie: string,
  ): Promise<SdrDrafterRunStatusResponse> {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const res = await app.inject({
        method: 'GET',
        url: `/teammates/sdr-drafter/runs/${runId}`,
        headers: { cookie },
      });
      if (res.statusCode === 200) {
        const body = res.json() as SdrDrafterRunStatusResponse;
        if (body.status !== 'running') return body;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `AgentRun ${runId} did not terminate in ${POLL_TIMEOUT_MS}ms`,
    );
  }

  async function createContact(args: {
    orgId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    title?: string;
    company?: string;
  }): Promise<{ id: string }> {
    return prisma.contact.create({
      data: {
        orgId: args.orgId,
        normalizedEmail: args.email,
        firstName: args.firstName ?? null,
        lastName: args.lastName ?? null,
        title: args.title ?? null,
        company: args.company ?? null,
      },
    });
  }

  // ─── POST /run validation ───────────────────────────────────────────

  it('returns 404 when the contactId does not exist in the caller org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/teammates/sdr-drafter/run',
      payload: { contactId: 'cuid_does_not_exist' },
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the contact belongs to a different org', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    const bobContact = await createContact({
      orgId: bob.orgId,
      email: 'lead@bobcorp.com',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/teammates/sdr-drafter/run',
      payload: { contactId: bobContact.id },
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the contact has no email', async () => {
    const contact = await prisma.contact.create({
      data: { orgId: alice.orgId, firstName: 'Sarah', linkedinUrl: 'x' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/teammates/sdr-drafter/run',
      payload: { contactId: contact.id },
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when briefDraftId belongs to a different org', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    const bobRun = await prisma.agentRun.create({
      data: { orgId: bob.orgId, teammate: 'researcher', triggeredBy: bob.userId },
    });
    const bobBrief = await prisma.draft.create({
      data: {
        orgId: bob.orgId,
        teammate: 'researcher',
        runId: bobRun.id,
        type: 'research_brief',
        content: {},
      },
    });
    const aliceContact = await createContact({
      orgId: alice.orgId,
      email: 'lead@acme.com',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/teammates/sdr-drafter/run',
      payload: { contactId: aliceContact.id, briefDraftId: bobBrief.id },
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── happy path ────────────────────────────────────────────────────

  it('completes the run, persists recipient on the Draft, and joins citation URLs in GET', async () => {
    const contact = await createContact({
      orgId: alice.orgId,
      email: 'sarah@acme.com',
      firstName: 'Sarah',
      lastName: 'Patel',
      title: 'VP Sales',
      company: 'Acme',
    });

    // Seed a research brief from a prior run with one citation.
    const priorRun = await prisma.agentRun.create({
      data: { orgId: alice.orgId, teammate: 'researcher', triggeredBy: alice.userId },
    });
    const priorCitation = await prisma.citation.create({
      data: {
        runId: priorRun.id,
        url: 'https://acme.example/about',
        title: 'Acme — About',
        excerpt: 'Acme just raised $5M Series A.',
      },
    });
    const brief = await prisma.draft.create({
      data: {
        orgId: alice.orgId,
        teammate: 'researcher',
        runId: priorRun.id,
        type: 'research_brief',
        content: { headline: 'Acme — Series A SaaS' },
        claims: {
          create: [
            {
              text: 'Acme raised $5M Series A.',
              citationId: priorCitation.id,
              abstained: false,
            },
          ],
        },
      },
    });

    // Drive the model: 1) get_contact, 2) get_research_brief, 3) emit_draft
    // referencing the citation id that get_research_brief returned.
    mockAnthropicCreate
      .mockResolvedValueOnce(
        fakeMessage({
          content: [
            toolUseBlock('get_contact', { contactId: contact.id }, 'tu-1'),
          ],
        }),
      )
      .mockResolvedValueOnce(
        fakeMessage({
          content: [
            toolUseBlock(
              'get_research_brief',
              { draftId: brief.id },
              'tu-2',
            ),
          ],
        }),
      )
      .mockImplementationOnce(async () => {
        // get_research_brief copied the prior Citation into THIS run with a
        // new id. Look it up — that's the id the model would cite.
        const freshCit = await prisma.citation.findFirst({
          where: {
            url: 'https://acme.example/about',
            runId: { not: priorRun.id },
          },
        });
        if (!freshCit) throw new Error('test: expected copied Citation');
        return fakeMessage({
          content: [
            toolUseBlock(
              'emit_draft',
              {
                type: 'email',
                content: {
                  subject: 'series a — quick question',
                  body:
                    'Sarah, saw Acme just closed Series A. Curious if outbound ' +
                    'is on the roadmap now. Worth 10 min?',
                },
                claims: [
                  {
                    text: 'Acme just raised $5M Series A.',
                    citationId: freshCit.id,
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
      url: '/teammates/sdr-drafter/run',
      payload: { contactId: contact.id, briefDraftId: brief.id },
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
    });
    expect(enqueueRes.statusCode).toBe(202);
    const { runId } = enqueueRes.json() as { runId: string; status: string };

    const finalState = await pollUntilDone(runId, alice.cookie);
    expect(finalState.status).toBe('completed');
    expect(finalState.draft).not.toBeNull();
    expect(finalState.draft?.type).toBe('email');
    expect(finalState.draft?.recipient).toEqual({
      contactId: contact.id,
      email: 'sarah@acme.com',
      name: 'Sarah Patel',
    });
    expect(finalState.draft?.claims).toHaveLength(1);
    expect(finalState.draft?.claims[0]?.citationUrl).toBe(
      'https://acme.example/about',
    );

    // Verify the brief's citation was actually COPIED into the new run, not
    // shared by reference. Citations remain per-run scoped.
    const allCits = await prisma.citation.findMany({
      where: { url: 'https://acme.example/about' },
    });
    expect(allCits).toHaveLength(2);
  });

  // ─── cross-tenant GET ───────────────────────────────────────────────

  it('GET runs/:id returns 403 when caller org does not match run owner', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    const contact = await createContact({
      orgId: alice.orgId,
      email: 'sarah@acme.com',
    });
    // Run belongs to alice's org.
    const run = await prisma.agentRun.create({
      data: {
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        triggeredBy: alice.userId,
        inputContext: { contactId: contact.id },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/teammates/sdr-drafter/runs/${run.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── happy path without a brief (web research path) ────────────────

  it('runs without a briefDraftId: uses web_search + fetch_url like the Researcher', async () => {
    const contact = await createContact({
      orgId: alice.orgId,
      email: 'tom@beta.com',
      firstName: 'Tom',
      company: 'Beta',
    });

    // Intercept the global fetch — the runtime tools resolve globalThis.fetch
    // lazily so this is sufficient. web_search hits the SearXNG instance,
    // fetch_url hits the result URL.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith('http://searxng.test')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Beta — homepage',
                url: 'https://beta.example/about',
                content: 'Beta builds healthcare scheduling.',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url === 'https://beta.example/about') {
        return new Response(
          '<html><body><h1>Beta</h1><p>Healthcare scheduling.</p></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      throw new Error(`fetch fell through for URL: ${url}`);
    }) as typeof fetch;

    try {
      let modelCallCount = 0;
      mockAnthropicCreate.mockImplementation(async () => {
        modelCallCount += 1;
        if (modelCallCount === 1) {
          return fakeMessage({
            content: [
              toolUseBlock(
                'get_contact',
                { contactId: contact.id },
                'tu-1',
              ),
            ],
          });
        }
        if (modelCallCount === 2) {
          return fakeMessage({
            content: [
              toolUseBlock(
                'web_search',
                { query: 'Beta healthcare scheduling' },
                'tu-2',
              ),
            ],
          });
        }
        if (modelCallCount === 3) {
          return fakeMessage({
            content: [
              toolUseBlock(
                'fetch_url',
                { url: 'https://beta.example/about' },
                'tu-3',
              ),
            ],
          });
        }
        const cit = await prisma.citation.findFirst({
          where: { url: 'https://beta.example/about' },
        });
        if (!cit) throw new Error('test: expected Citation by now');
        return fakeMessage({
          content: [
            toolUseBlock(
              'emit_draft',
              {
                type: 'email',
                content: {
                  subject: 'beta scheduling',
                  body: 'Tom, saw Beta runs healthcare scheduling. Quick q?',
                },
                claims: [
                  {
                    text: 'Beta builds healthcare scheduling.',
                    citationId: cit.id,
                  },
                ],
              },
              'tu-4',
            ),
          ],
        });
      });

      const enqueueRes = await app.inject({
        method: 'POST',
        url: '/teammates/sdr-drafter/run',
        payload: { contactId: contact.id, goal: 'intro outreach' },
        headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      });
      expect(enqueueRes.statusCode).toBe(202);
      const { runId } = enqueueRes.json() as { runId: string };

      const finalState = await pollUntilDone(runId, alice.cookie);
      expect(finalState.status).toBe('completed');
      expect(finalState.draft?.recipient).toEqual({
        contactId: contact.id,
        email: 'tom@beta.com',
        name: 'Tom',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ─── SSE stream ────────────────────────────────────────────────────

  // (The "already-terminal run → synthesized event" path is identical
  // between Researcher and SDR Drafter; researcher.stream.integration
  // covers it via a real HTTP client. app.inject doesn't play nicely
  // with SSE Observable responses, so we restrict this spec to the
  // pre-stream validation paths.)

  it('SSE stream returns 404 for an unknown run id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/teammates/sdr-drafter/runs/cuid_does_not_exist/stream',
      headers: { cookie: alice.cookie, accept: 'text/event-stream' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('SSE stream returns 403 cross-org', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    const run = await prisma.agentRun.create({
      data: {
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        triggeredBy: alice.userId,
        status: 'running',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/teammates/sdr-drafter/runs/${run.id}/stream`,
      headers: { cookie: bob.cookie, accept: 'text/event-stream' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── get_research_brief abstained-claim path ────────────────────────

  it('get_research_brief surfaces abstained claims with null citation', async () => {
    const contact = await createContact({
      orgId: alice.orgId,
      email: 'sarah@acme.com',
      firstName: 'Sarah',
    });
    const priorRun = await prisma.agentRun.create({
      data: { orgId: alice.orgId, teammate: 'researcher', triggeredBy: alice.userId },
    });
    const brief = await prisma.draft.create({
      data: {
        orgId: alice.orgId,
        teammate: 'researcher',
        runId: priorRun.id,
        type: 'research_brief',
        content: { headline: 'No public info' },
        claims: {
          create: [
            {
              text: 'No public funding announcements found.',
              citationId: null,
              abstained: true,
            },
          ],
        },
      },
    });

    let modelCallCount = 0;
    mockAnthropicCreate.mockImplementation(async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return fakeMessage({
          content: [
            toolUseBlock(
              'get_research_brief',
              { draftId: brief.id },
              'tu-1',
            ),
          ],
        });
      }
      // Emit a draft with an abstained claim — the runtime preserves these.
      return fakeMessage({
        content: [
          toolUseBlock(
            'emit_draft',
            {
              type: 'email',
              content: {
                subject: 'quick intro',
                body: 'Sarah, brief hello.',
              },
              claims: [
                {
                  text: 'No source for this prospect-specific fact.',
                  citationId: null,
                  abstained: true,
                },
              ],
            },
            'tu-2',
          ),
        ],
      });
    });

    const enqueueRes = await app.inject({
      method: 'POST',
      url: '/teammates/sdr-drafter/run',
      payload: { contactId: contact.id, briefDraftId: brief.id },
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
    });
    expect(enqueueRes.statusCode).toBe(202);
    const { runId } = enqueueRes.json() as { runId: string };
    const finalState = await pollUntilDone(runId, alice.cookie);
    expect(finalState.status).toBe('completed');
    expect(finalState.draft?.claims[0]?.abstained).toBe(true);
  });
});
