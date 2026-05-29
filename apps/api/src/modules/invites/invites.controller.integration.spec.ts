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

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('Org invites + acceptance', () => {
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
    process.env.BRAVE_SEARCH_API_KEY ||= 'test-brave-key';

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
        invites, sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
    alice = await createTestSession(prisma, auth, 'alice@test.com');
  });

  // ─── POST /org/invites ─────────────────────────────────────────────────

  it('owner creates an invite as member; appears in GET /org/invites', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com', role: 'member' }),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; status: string; email: string };
    expect(created.status).toBe('pending');
    expect(created.email).toBe('bob@test.com');

    const listRes = await app.inject({
      method: 'GET',
      url: '/org/invites',
      headers: { cookie: alice.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as Array<{ id: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
  });

  it('owner can invite as admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'carol@test.com', role: 'admin' }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { role: string }).role).toBe('admin');
  });

  it('admin cannot invite as admin (403)', async () => {
    // Promote a second user to admin manually for this test.
    const carol = await createTestSession(prisma, auth, 'carol@test.com');
    await prisma.orgMembership.create({
      data: { userId: carol.userId, orgId: alice.orgId, role: 'admin' },
    });
    await prisma.user.update({
      where: { id: carol.userId },
      data: { activeOrgId: alice.orgId },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: carol.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'dan@test.com', role: 'admin' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('member cannot invite at all (403)', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    await prisma.orgMembership.create({
      data: { userId: bob.userId, orgId: alice.orgId, role: 'member' },
    });
    await prisma.user.update({
      where: { id: bob.userId },
      data: { activeOrgId: alice.orgId },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: bob.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'eve@test.com' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot invite an email already a member of the org (409)', async () => {
    // Alice tries to invite herself.
    const res = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@test.com' }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('re-inviting the same email refreshes the token (upsert)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const firstRow = await prisma.invite.findFirstOrThrow({
      where: { email: 'bob@test.com' },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com', role: 'admin' }),
    });
    expect(second.statusCode).toBe(201);

    const rows = await prisma.invite.findMany({
      where: { email: 'bob@test.com' },
    });
    expect(rows).toHaveLength(1); // upserted, not appended
    expect(rows[0]?.token).not.toBe(firstRow.token);
    expect(rows[0]?.role).toBe('admin');
    expect(rows[0]?.id).toBe(firstRow.id);
    expect((first.json() as { id: string }).id).toBe(firstRow.id);
  });

  // ─── DELETE /org/invites/:id ───────────────────────────────────────────

  it('owner revokes an invite; lookup shows revoked', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const inviteId = (create.json() as { id: string }).id;
    const token = (
      await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } })
    ).token;

    const del = await app.inject({
      method: 'DELETE',
      url: `/org/invites/${inviteId}`,
      headers: { cookie: alice.cookie },
    });
    expect(del.statusCode).toBe(200);

    const lookup = await app.inject({
      method: 'GET',
      url: `/invite/${token}/lookup`,
    });
    expect(lookup.statusCode).toBe(200);
    expect((lookup.json() as { status: string }).status).toBe('revoked');
  });

  it('member cannot revoke (403)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const inviteId = (create.json() as { id: string }).id;

    const bob = await createTestSession(prisma, auth, 'bobmember@test.com');
    await prisma.orgMembership.create({
      data: { userId: bob.userId, orgId: alice.orgId, role: 'member' },
    });
    await prisma.user.update({
      where: { id: bob.userId },
      data: { activeOrgId: alice.orgId },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/org/invites/${inviteId}`,
      headers: { cookie: bob.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── /invite/:token/lookup ────────────────────────────────────────────

  it('lookup is public and returns the invite details', async () => {
    await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com', role: 'admin' }),
    });
    const row = await prisma.invite.findFirstOrThrow({
      where: { email: 'bob@test.com' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/invite/${row.token}/lookup`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      role: string;
      invitedEmail: string;
    };
    expect(body.status).toBe('pending');
    expect(body.role).toBe('admin');
    expect(body.invitedEmail).toBe('bob@test.com');
  });

  it('lookup returns 404 for an unknown token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/invite/unknown-token/lookup',
    });
    expect(res.statusCode).toBe(404);
  });

  it('lookup status is "expired" once expiresAt has passed', async () => {
    await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const row = await prisma.invite.findFirstOrThrow({
      where: { email: 'bob@test.com' },
    });
    await prisma.invite.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/invite/${row.token}/lookup`,
    });
    expect((res.json() as { status: string }).status).toBe('expired');
  });

  // ─── /invite/:token/accept ────────────────────────────────────────────

  it('existing user accepts and gains a membership in the inviting org', async () => {
    // Pre-existing user bob with his own org.
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    expect(bob.orgId).not.toBe(alice.orgId);

    // Alice invites bob.
    await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com', role: 'admin' }),
    });
    const row = await prisma.invite.findFirstOrThrow({
      where: { email: 'bob@test.com' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/invite/${row.token}/accept`,
      headers: { cookie: bob.cookie },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { orgId: string; role: string };
    expect(body.orgId).toBe(alice.orgId);
    expect(body.role).toBe('admin');

    const memberships = await prisma.orgMembership.findMany({
      where: { userId: bob.userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(memberships).toHaveLength(2);
    expect(memberships.find((m) => m.orgId === alice.orgId)?.role).toBe(
      'admin',
    );

    const after = await prisma.invite.findUnique({ where: { id: row.id } });
    expect(after?.acceptedByUserId).toBe(bob.userId);
    expect(after?.acceptedAt).toBeInstanceOf(Date);
  });

  it('accept rejects when the session email does not match the invite (403)', async () => {
    const eve = await createTestSession(prisma, auth, 'eve@test.com');
    await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const row = await prisma.invite.findFirstOrThrow({
      where: { email: 'bob@test.com' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/invite/${row.token}/accept`,
      headers: { cookie: eve.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accept rejects a revoked invite (400)', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    const create = await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const inviteId = (create.json() as { id: string }).id;
    await app.inject({
      method: 'DELETE',
      url: `/org/invites/${inviteId}`,
      headers: { cookie: alice.cookie },
    });
    const row = await prisma.invite.findUniqueOrThrow({
      where: { id: inviteId },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/invite/${row.token}/accept`,
      headers: { cookie: bob.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accept is idempotent — clicking twice does not duplicate the membership', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'bob@test.com' }),
    });
    const row = await prisma.invite.findFirstOrThrow({
      where: { email: 'bob@test.com' },
    });

    const first = await app.inject({
      method: 'POST',
      url: `/invite/${row.token}/accept`,
      headers: { cookie: bob.cookie },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/invite/${row.token}/accept`,
      headers: { cookie: bob.cookie },
    });
    // Second click: status is 'accepted' so the route 400s. The first call
    // is what created the membership; idempotent in the data sense.
    expect(second.statusCode).toBe(400);

    const memberships = await prisma.orgMembership.findMany({
      where: { userId: bob.userId, orgId: alice.orgId },
    });
    expect(memberships).toHaveLength(1);
  });

  // ─── Signup with pending invite (hook detour) ─────────────────────────

  it('new user signup with pending invite attaches to inviting org with invite role', async () => {
    // Alice invites a brand-new email.
    await app.inject({
      method: 'POST',
      url: '/org/invites',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'fresh@test.com', role: 'admin' }),
    });

    // The invitee signs up via the standard magic-link flow.
    const fresh = await createTestSession(prisma, auth, 'fresh@test.com');

    // No new org was created; activeOrg is alice's.
    expect(fresh.orgId).toBe(alice.orgId);

    const memberships = await prisma.orgMembership.findMany({
      where: { userId: fresh.userId },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.orgId).toBe(alice.orgId);
    expect(memberships[0]?.role).toBe('admin');

    // Invite is marked accepted.
    const invite = await prisma.invite.findFirstOrThrow({
      where: { email: 'fresh@test.com' },
    });
    expect(invite.acceptedAt).toBeInstanceOf(Date);
    expect(invite.acceptedByUserId).toBe(fresh.userId);

    // Regression: no orphaned org was created (only alice's exists).
    const orgs = await prisma.organization.findMany();
    expect(orgs).toHaveLength(1);
  });

  it('new user signup without an invite still creates their own org as owner', async () => {
    const grace = await createTestSession(prisma, auth, 'grace@test.com');
    expect(grace.orgId).not.toBe(alice.orgId);

    const memberships = await prisma.orgMembership.findMany({
      where: { userId: grace.userId },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('owner');
  });

  // ─── GET /org/members ──────────────────────────────────────────────────

  it('lists members of the active org with their roles', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    await prisma.orgMembership.create({
      data: { userId: bob.userId, orgId: alice.orgId, role: 'admin' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/org/members',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ email: string; role: string }>;
    expect(body).toHaveLength(2);
    const alice0 = body.find((b) => b.email === 'alice@test.com');
    const bob0 = body.find((b) => b.email === 'bob@test.com');
    expect(alice0?.role).toBe('owner');
    expect(bob0?.role).toBe('admin');
  });
});
