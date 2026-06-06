import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';

/**
 * /api/auth/* round-trip via the AuthController catch-all.
 *
 * createTestSession exercises the auth.api.* methods directly, which leaves
 * the Fastify ↔ web-Request bridge in AuthController unexercised. This
 * spec drives the full HTTP path through the controller so we cover the
 * body re-serialization, header coercion, and set-cookie splitting logic.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('AuthController (/api/auth/* round-trip)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (!dbName.includes('test')) {
      throw new Error(
        `Integration tests refuse to run against database "${dbName}".`,
      );
    }
    process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
    process.env.SEARXNG_URL ||= 'http://searxng.test';
    process.env.CREDENTIAL_MASTER_KEY ||= Buffer.from(
      new Uint8Array(32).fill(7),
    ).toString('base64');
    process.env.AUTH_SECRET ||= 'test-auth-secret-32-chars-padding-to-match';

    const { AppModule } = await import('../../app.module');
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
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        invites, sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
  });

  it('POST /api/auth/sign-in/magic-link writes a Verification row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'alice@test.com',
        callbackURL: 'http://localhost:3001/research/new',
      }),
    });
    expect(res.statusCode).toBe(200);
    const verifications = await prisma.verification.findMany();
    expect(verifications).toHaveLength(1);
    // identifier is the random token; the email lives inside `value` JSON.
    const payload = JSON.parse(verifications[0]!.value) as { email: string };
    expect(payload.email).toBe('alice@test.com');
  });

  it('GET /api/auth/get-session returns null when no cookie is sent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
    });
    expect(res.statusCode).toBe(200);
    // No session → better-auth returns null, not an error.
    const text = res.payload;
    expect(text === 'null' || text === '' || text === '{}').toBe(true);
  });

  it('round-trip: magic-link → verify → set-cookie → get-session', async () => {
    // 1. signInMagicLink via the controller (NOT via auth.api directly).
    const signInRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'alice@test.com',
        callbackURL: 'http://localhost:3001/research/new',
      }),
    });
    expect(signInRes.statusCode).toBe(200);

    // 2. Pull the token out of the Verification row.
    const verifications = await prisma.verification.findMany();
    expect(verifications).toHaveLength(1);
    const token = verifications[0]!.identifier;

    // 3. Hit the verify endpoint. better-auth issues a 302 with a Set-Cookie.
    const verifyRes = await app.inject({
      method: 'GET',
      url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('http://localhost:3001/research/new')}`,
    });
    // better-auth typically responds 302 → callbackURL with the cookie set.
    expect([200, 302]).toContain(verifyRes.statusCode);

    // 4. Extract the session cookie from set-cookie and round-trip get-session.
    const setCookieHeaders = verifyRes.headers['set-cookie'];
    const cookieList = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders
        ? [String(setCookieHeaders)]
        : [];
    expect(cookieList.length).toBeGreaterThan(0);
    const cookie = cookieList
      .map((c) => c.split(';')[0]?.trim())
      .filter(Boolean)
      .join('; ');

    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(sessionRes.statusCode).toBe(200);
    const session = sessionRes.json() as {
      user?: { email?: string; activeOrgId?: string };
    } | null;
    expect(session?.user?.email).toBe('alice@test.com');
    expect(session?.user?.activeOrgId).toBeTruthy();
  });
});
