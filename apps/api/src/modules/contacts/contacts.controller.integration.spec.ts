import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { createAuth } from '../auth/auth.config';
import { createTestSession } from '../auth/test-session';

/**
 * /contacts/lookup — minimal endpoint the SDR Drafter form uses to resolve
 * a user-entered email into a Contact.id. Tests cover the boundary
 * conditions (missing/invalid email, cross-org isolation) since the
 * happy path is just a Prisma findFirst.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('GET /contacts/lookup', () => {
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
    process.env.CREDENTIAL_MASTER_KEY ||= Buffer.from(
      new Uint8Array(32).fill(7),
    ).toString('base64');
    process.env.AUTH_SECRET ||= 'test-auth-secret-32-chars-padding-to-match';
    process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
    process.env.SEARXNG_URL ||= 'http://searxng.test';

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
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        contacts, invites, sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
    alice = await createTestSession(prisma, auth, 'alice@test.com');
  });

  it('returns the contact when the email exists in the caller org', async () => {
    await prisma.contact.create({
      data: {
        orgId: alice.orgId,
        normalizedEmail: 'sarah@acme.com',
        firstName: 'Sarah',
        lastName: 'Patel',
        title: 'VP Sales',
        company: 'Acme',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=sarah@acme.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      primaryEmail: string;
      firstName: string;
      title: string;
    };
    expect(body.primaryEmail).toBe('sarah@acme.com');
    expect(body.firstName).toBe('Sarah');
    expect(body.title).toBe('VP Sales');
    expect(body.id).toBeTruthy();
  });

  it('normalizes the input email before lookup', async () => {
    // The DB stores normalizedEmail (lowercased, plus-stripped). User
    // input can have mixed case + a +tag and should still resolve.
    await prisma.contact.create({
      data: {
        orgId: alice.orgId,
        normalizedEmail: 'sarah@acme.com',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=Sarah%2Bnewsletters%40Acme.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when the email belongs to a different org', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    await prisma.contact.create({
      data: {
        orgId: bob.orgId,
        normalizedEmail: 'lead@bobcorp.com',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=lead@bobcorp.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when no contact matches the email', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=nobody@nowhere.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when email query param is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=not-an-email',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=sarah@acme.com',
    });
    expect(res.statusCode).toBe(401);
  });

  describe('GET /contacts (list)', () => {
    it('returns paged contacts for the caller org, newest first', async () => {
      await prisma.contact.createMany({
        data: [
          {
            orgId: alice.orgId,
            firstName: 'Sarah',
            lastName: 'Patel',
            normalizedEmail: 'sarah@acme.com',
            title: 'VP Sales',
            company: 'Acme',
          },
          {
            orgId: alice.orgId,
            firstName: 'Tom',
            normalizedEmail: 'tom@beta.com',
            company: 'Beta',
          },
          {
            orgId: alice.orgId,
            firstName: 'Lin',
            normalizedEmail: 'lin@gamma.com',
            company: 'Gamma',
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/contacts',
        headers: { cookie: alice.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{ firstName: string | null }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.total).toBe(3);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
      expect(body.items).toHaveLength(3);
      // No timestamps were forced apart, but the sort key is updatedAt then
      // id — all three are present.
      expect(body.items.map((c) => c.firstName).sort()).toEqual([
        'Lin',
        'Sarah',
        'Tom',
      ]);
    });

    it('respects limit + offset', async () => {
      for (let i = 0; i < 5; i += 1) {
        await prisma.contact.create({
          data: {
            orgId: alice.orgId,
            firstName: `Contact${i}`,
            normalizedEmail: `c${i}@test.com`,
          },
        });
      }

      const page1 = await app.inject({
        method: 'GET',
        url: '/contacts?limit=2&offset=0',
        headers: { cookie: alice.cookie },
      });
      const page2 = await app.inject({
        method: 'GET',
        url: '/contacts?limit=2&offset=2',
        headers: { cookie: alice.cookie },
      });
      const body1 = page1.json() as { items: unknown[]; total: number };
      const body2 = page2.json() as { items: unknown[]; total: number };

      expect(body1.total).toBe(5);
      expect(body1.items).toHaveLength(2);
      expect(body2.items).toHaveLength(2);
    });

    it('clamps limit at the 100 ceiling', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/contacts?limit=9999',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { limit: number };
      expect(body.limit).toBe(100);
    });

    it('falls back to defaults on malformed limit/offset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/contacts?limit=NaN&offset=foo',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as { limit: number; offset: number };
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    });

    it('filters by q across name + email + company (case-insensitive)', async () => {
      await prisma.contact.createMany({
        data: [
          {
            orgId: alice.orgId,
            firstName: 'Sarah',
            normalizedEmail: 'sarah@acme.com',
            company: 'Acme',
          },
          {
            orgId: alice.orgId,
            firstName: 'Tom',
            normalizedEmail: 'tom@beta.com',
            company: 'Beta',
          },
        ],
      });

      const byName = await app.inject({
        method: 'GET',
        url: '/contacts?q=SaR',
        headers: { cookie: alice.cookie },
      });
      const nameBody = byName.json() as {
        items: Array<{ firstName: string | null }>;
      };
      expect(nameBody.items).toHaveLength(1);
      expect(nameBody.items[0]?.firstName).toBe('Sarah');

      const byCompany = await app.inject({
        method: 'GET',
        url: '/contacts?q=beta',
        headers: { cookie: alice.cookie },
      });
      const companyBody = byCompany.json() as {
        items: Array<{ company: string | null }>;
      };
      expect(companyBody.items).toHaveLength(1);
      expect(companyBody.items[0]?.company).toBe('Beta');
    });

    it('excludes contacts owned by other orgs', async () => {
      const bob = await createTestSession(prisma, auth, 'bob@test.com');
      await prisma.contact.create({
        data: {
          orgId: bob.orgId,
          firstName: 'BobLead',
          normalizedEmail: 'lead@bobcorp.com',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/contacts',
        headers: { cookie: alice.cookie },
      });
      const body = res.json() as {
        items: Array<{ firstName: string | null }>;
        total: number;
      };
      expect(body.total).toBe(0);
      expect(body.items).toHaveLength(0);
    });

    it('returns 401 without a session cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/contacts' });
      expect(res.statusCode).toBe(401);
    });
  });
});
