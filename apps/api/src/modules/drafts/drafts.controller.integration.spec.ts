import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { type Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { createAuth } from '../auth/auth.config';
import { createTestSession } from '../auth/test-session';

/**
 * GET /drafts (list) + GET /drafts/:id (detail).
 *
 * Powers the approval-queue UI. The detail view returns Claims with their
 * Citation rows joined — that's the trust surface we want visible per
 * draft.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('drafts inbox', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let auth: ReturnType<typeof createAuth>;
  let alice: { cookie: string; userId: string; orgId: string };

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (!dbName.includes('test')) {
      throw new Error(
        `Integration tests refuse to run against database "${dbName}".`,
      );
    }
    process.env.CREDENTIAL_MASTER_KEY ??= Buffer.from(
      new Uint8Array(32).fill(7),
    ).toString('base64');
    process.env.AUTH_SECRET ??= 'test-auth-secret-32-chars-padding-to-match';
    process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';
    process.env.BRAVE_SEARCH_API_KEY ??= 'test-brave-key';

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
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        claims, citations, drafts, agent_runs,
        contacts, invites,
        sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
    alice = await createTestSession(prisma, auth, 'alice@test.com');
  });

  async function seedDraft(args: {
    orgId: string;
    teammate: string;
    type: 'email' | 'linkedin_post' | 'research_brief';
    status?:
      | 'pending'
      | 'approved'
      | 'rejected'
      | 'edited'
      | 'sent'
      | 'partial'
      | 'failed';
    content?: Prisma.InputJsonValue;
  }): Promise<string> {
    const run = await prisma.agentRun.create({
      data: {
        orgId: args.orgId,
        teammate: args.teammate,
        triggeredBy: 'u-test',
        status: 'completed',
      },
    });
    const draft = await prisma.draft.create({
      data: {
        orgId: args.orgId,
        teammate: args.teammate,
        runId: run.id,
        type: args.type,
        status: args.status ?? 'pending',
        recipient: { email: 'lead@acme.com', name: 'Lead' },
        content: args.content ?? { subject: 'hi', body: 'hello there' },
      },
    });
    return draft.id;
  }

  describe('GET /drafts', () => {
    it('returns the caller-org drafts, newest first', async () => {
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
      });
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'researcher',
        type: 'research_brief',
        content: { headline: 'Acme Q1 brief', body: 'context...' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts',
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{ teammate: string; contentPreview: string }>;
        total: number;
      };
      expect(body.total).toBe(2);
      expect(body.items[0]?.teammate).toBe('researcher');
      expect(body.items[0]?.contentPreview).toBe('Acme Q1 brief');
      expect(body.items[1]?.teammate).toBe('sdr-drafter');
      expect(body.items[1]?.contentPreview).toBe('hi');
    });

    it('filters by status', async () => {
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
        status: 'pending',
      });
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
        status: 'approved',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts?status=approved',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { total: number };
      expect(body.total).toBe(1);
    });

    it('filters by teammate', async () => {
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
      });
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'researcher',
        type: 'research_brief',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts?teammate=researcher',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as {
        items: Array<{ teammate: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items[0]?.teammate).toBe('researcher');
    });

    it('filters by type', async () => {
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
      });
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'content-drafter',
        type: 'linkedin_post',
        content: { body: 'a post' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts?type=linkedin_post',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { total: number };
      expect(body.total).toBe(1);
    });

    it('ignores unknown status / type values and returns everything', async () => {
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts?status=banana&type=mango',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { total: number };
      expect(body.total).toBe(1);
    });

    it('clamps limit at 100', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/drafts?limit=9999',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { limit: number };
      expect(body.limit).toBe(100);
    });

    it('excludes drafts owned by other orgs', async () => {
      const bob = await createTestSession(prisma, auth, 'bob@test.com');
      await seedDraft({
        orgId: bob.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { total: number };
      expect(body.total).toBe(0);
    });

    it('truncates long content previews with an ellipsis', async () => {
      const longBody = 'x'.repeat(500);
      await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
        content: { subject: '', body: longBody },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/drafts',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as {
        items: Array<{ contentPreview: string }>;
      };
      const preview = body.items[0]?.contentPreview ?? '';
      expect(preview.endsWith('…')).toBe(true);
      expect(preview.length).toBeLessThanOrEqual(241);
    });

    it('returns 401 without a session cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/drafts' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /drafts/:id', () => {
    it('returns the draft with claims + their citations', async () => {
      const draftId = await seedDraft({
        orgId: alice.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
        content: { subject: 'hi', body: 'hello there' },
      });
      const draft = await prisma.draft.findUniqueOrThrow({
        where: { id: draftId },
      });
      const citation = await prisma.citation.create({
        data: {
          runId: draft.runId!,
          url: 'https://acme.com/blog',
          title: 'Acme blog post',
          excerpt: 'They just shipped X.',
        },
      });
      await prisma.claim.create({
        data: {
          draftId,
          text: 'Acme shipped feature X this week.',
          citationId: citation.id,
          confidence: 0.92,
        },
      });
      await prisma.claim.create({
        data: {
          draftId,
          text: 'No idea about their team size.',
          abstained: true,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/drafts/${draftId}`,
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        id: string;
        claims: Array<{
          text: string;
          abstained: boolean;
          citation: { url: string } | null;
        }>;
      };
      expect(body.id).toBe(draftId);
      expect(body.claims).toHaveLength(2);
      expect(body.claims[0]?.citation?.url).toBe('https://acme.com/blog');
      expect(body.claims[1]?.abstained).toBe(true);
      expect(body.claims[1]?.citation).toBeNull();
    });

    it('returns 404 for a draft in another org', async () => {
      const bob = await createTestSession(prisma, auth, 'bob@test.com');
      const otherId = await seedDraft({
        orgId: bob.orgId,
        teammate: 'sdr-drafter',
        type: 'email',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/drafts/${otherId}`,
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for an unknown draft id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/drafts/draft-not-real',
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without a session cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/drafts/anything',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
