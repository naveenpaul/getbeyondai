import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { createAuth } from './auth.config';
import { createTestSession } from './test-session';

/**
 * /me + /me/active-org — multi-org switching.
 *
 * Covers the contract every web client needs: who am I, which orgs do I
 * belong to, and how do I switch which one is active. The membership
 * lookup AuthGuard does is exercised implicitly — a request with a
 * revoked membership 401s.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('GET /me + POST /me/active-org', () => {
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
        sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
    alice = await createTestSession(prisma, auth, 'alice@test.com');
  });

  it('GET /me returns the active org and the membership list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      userId: string;
      email: string;
      activeOrgId: string;
      orgs: Array<{ id: string; role: string }>;
    };
    expect(body.userId).toBe(alice.userId);
    expect(body.email).toBe('alice@test.com');
    expect(body.activeOrgId).toBe(alice.orgId);
    expect(body.orgs).toHaveLength(1);
    expect(body.orgs[0]?.id).toBe(alice.orgId);
    expect(body.orgs[0]?.role).toBe('owner');
  });

  it('GET /me returns 401 without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /me/active-org switches the active org when membership exists', async () => {
    // Create a second org + membership for alice manually (Chunk B will do
    // this via the invite flow).
    const otherOrg = await prisma.organization.create({
      data: { name: 'Other Org' },
    });
    await prisma.orgMembership.create({
      data: { userId: alice.userId, orgId: otherOrg.id, role: 'member' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/me/active-org',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ orgId: otherOrg.id }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { activeOrgId: string; orgs: unknown[] };
    expect(body.activeOrgId).toBe(otherOrg.id);
    expect(body.orgs).toHaveLength(2);

    // And the User row reflects the new active org.
    const stored = await prisma.user.findUnique({
      where: { id: alice.userId },
    });
    expect(stored?.activeOrgId).toBe(otherOrg.id);
  });

  it('POST /me/active-org returns 403 when the user is not a member of the target org', async () => {
    const strangerOrg = await prisma.organization.create({
      data: { name: 'Stranger Org' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/me/active-org',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ orgId: strangerOrg.id }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('AuthGuard rejects a session whose membership was revoked', async () => {
    // Remove alice's only membership. Next /me hit should 401 even though
    // the session cookie is still valid.
    await prisma.orgMembership.deleteMany({
      where: { userId: alice.userId },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
