import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';

/**
 * Email + password auth round-trip via the AuthController catch-all (T6.x).
 *
 * Password auth is the zero-email-infra baseline for self-hosters: it works
 * with nothing but a Postgres connection (no SMTP / Resend). This spec drives
 * the full HTTP path — sign-up, sign-in, wrong-password — and asserts the
 * shared databaseHooks (org + owner membership creation) fire identically to
 * the magic-link path.
 */

const DATABASE_URL = process.env.DATABASE_URL;

/** Extract the joined `name=value` cookie header from a Set-Cookie response. */
function cookieFromResponse(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [String(setCookie)]
      : [];
  return list
    .map((c) => c.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

describe.skipIf(!DATABASE_URL)(
  'AuthController (email+password round-trip)',
  () => {
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

    it('POST /api/auth/sign-up/email creates user, org, owner membership + session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'founder@test.com',
          password: 'correct-horse-battery',
          name: 'Founder',
        }),
      });
      expect(res.statusCode).toBe(200);

      // autoSignIn → a session cookie is set on sign-up.
      expect(cookieFromResponse(res.headers['set-cookie']).length).toBeGreaterThan(
        0,
      );

      const user = await prisma.user.findUnique({
        where: { email: 'founder@test.com' },
        include: { memberships: true, activeOrg: true },
      });
      expect(user).toBeTruthy();
      expect(user!.activeOrgId).toBeTruthy();
      expect(user!.memberships).toHaveLength(1);
      expect(user!.memberships[0]!.role).toBe('owner');
      expect(user!.memberships[0]!.orgId).toBe(user!.activeOrgId);

      // The password is stored bcrypted on the credential Account, never plain.
      const account = await prisma.account.findFirst({
        where: { userId: user!.id, providerId: 'credential' },
      });
      expect(account).toBeTruthy();
      expect(account!.password).toBeTruthy();
      expect(account!.password).not.toBe('correct-horse-battery');
    });

    it('round-trip: sign-up → sign-in → get-session', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'founder@test.com',
          password: 'correct-horse-battery',
          name: 'Founder',
        }),
      });

      const signInRes = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'founder@test.com',
          password: 'correct-horse-battery',
        }),
      });
      expect(signInRes.statusCode).toBe(200);
      const cookie = cookieFromResponse(signInRes.headers['set-cookie']);
      expect(cookie.length).toBeGreaterThan(0);

      const sessionRes = await app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers: { cookie },
      });
      expect(sessionRes.statusCode).toBe(200);
      const session = sessionRes.json() as {
        user?: { email?: string; activeOrgId?: string };
      } | null;
      expect(session?.user?.email).toBe('founder@test.com');
      expect(session?.user?.activeOrgId).toBeTruthy();
    });

    it('rejects sign-in with the wrong password', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'founder@test.com',
          password: 'correct-horse-battery',
          name: 'Founder',
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'founder@test.com',
          password: 'wrong-password',
        }),
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(cookieFromResponse(res.headers['set-cookie'])).toBe('');
    });
  },
);
