import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink } from 'better-auth/plugins';
import { PrismaClient } from '@prisma/client';

/**
 * better-auth instance + factory (T6.2).
 *
 * Email magic-link only for v1 (no Google/LinkedIn OAuth yet — keeps the
 * setup surface minimal). Plan calls for those providers later; they slot
 * in as additional plugins without changing the User/Session shape.
 *
 * Where the orgId comes from:
 *   - Our User table requires `orgId` NOT NULL but better-auth has no
 *     concept of orgs. We use `databaseHooks.user.create.before` to create
 *     an Organization first, then return the user data with `orgId` set.
 *     This keeps the foreign key strict + the User row + the Org row land
 *     in the same transaction (better-auth's adapter wraps create-hooks
 *     in a tx when `transaction: true` is set on the prismaAdapter).
 *
 * Magic-link delivery:
 *   - Dev: write the URL to stdout. The developer clicks the link in their
 *     terminal. No SMTP needed.
 *   - Prod: send via Resend (RESEND_API_KEY in env). v1 doesn't ship the
 *     full Resend wiring — that lands when we have a real production
 *     deploy target. For now non-dev environments throw if RESEND_API_KEY
 *     is missing, so the failure mode is loud.
 *
 * SDK quarantine:
 *   - This is the ONLY file that imports `better-auth`. The route handler
 *     in `auth.controller.ts` consumes `auth.handler`, not the betterAuth
 *     module surface.
 */

const BASE_URL =
  process.env.AUTH_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 3000}`;

const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAGIC_LINK_EXPIRY_SECONDS = 60 * 15; // 15 min

/**
 * Build an Organization name from the user's email. Friendly default for
 * solo founders signing up with their own address; settings UI lets them
 * rename later.
 */
function deriveOrgName(email: string): string {
  const local = email.split('@')[0] ?? 'getbeyond';
  return `${local}'s organization`;
}

/**
 * Send the magic link. Dev = console; prod = Resend (later).
 * Throws in non-dev environments when no provider is wired so the failure
 * is impossible to miss.
 */
async function sendMagicLink(
  prisma: PrismaClient,
  data: { email: string; url: string; token: string },
): Promise<void> {
  // "Not production" covers both development AND test. In tests this just
  // means the link writes to stdout; the test harness reads it back from
  // the Verification table directly (see createTestSession).
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(
        `\n[auth] Magic link for ${data.email}:\n  ${data.url}\n  (token ${data.token.slice(0, 8)}…, expires in ${MAGIC_LINK_EXPIRY_SECONDS}s)\n`,
      );
    }
    return;
  }
  // Resend integration lands when we have a prod deploy target. Fail loud
  // until then so silent breakage is impossible.
  void prisma;
  throw new Error(
    'Magic-link delivery is not configured for non-development environments. ' +
      'Wire Resend (RESEND_API_KEY) or another transport before signing in.',
  );
}

// Return type intentionally inferred — better-auth's typing depends on the
// concrete plugins + additionalFields passed in, and an explicit annotation
// strips that inference (the result becomes a generic `Auth<BetterAuthOptions>`
// that doesn't carry our `orgId` field on User).
export function createAuth(prisma: PrismaClient) {
  return betterAuth({
    baseURL: BASE_URL,
    basePath: '/api/auth',
    secret:
      process.env.AUTH_SECRET ??
      // Fall back to JWT_SECRET only in development. Production must set
      // AUTH_SECRET independently — better-auth uses it to sign session
      // cookies and a leaked AUTH_SECRET = silent session forgery.
      (process.env.NODE_ENV === 'production'
        ? undefinedThrow('AUTH_SECRET is required in production')
        : (process.env.JWT_SECRET ?? 'dev-only-secret-do-not-use-in-prod')),
    trustedOrigins: (process.env.CORS_ORIGIN?.split(',') ?? [
      'http://localhost:3001',
    ]).map((s) => s.trim()),
    database: prismaAdapter(prisma, {
      provider: 'postgresql',
      usePlural: true, // our @@map calls are plural: users, sessions, accounts, verifications
    }),
    session: {
      expiresIn: SESSION_DURATION_SECONDS,
      updateAge: 60 * 60 * 24, // refresh cookie if older than 1 day
    },
    user: {
      additionalFields: {
        // activeOrgId rides on the session user. AuthGuard verifies a
        // matching OrgMembership exists each request before trusting it.
        activeOrgId: { type: 'string', required: true, input: false },
      },
    },
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRY_SECONDS,
        sendMagicLink: async ({ email, url, token }) => {
          await sendMagicLink(prisma, { email, url, token });
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Signup paths:
            //   1. Invited: a pending Invite exists for this email — attach
            //      to the inviting org as the invited role. No new org.
            //   2. Fresh: create a new org and become its owner.
            // The matching OrgMembership row + invite acceptance happen in
            // `after` once the User row's id exists. better-auth's prisma
            // adapter runs create in a transaction so a hook failure rolls
            // everything back.
            const email =
              (user as { email?: string } | undefined)?.email ?? 'unknown';

            const pendingInvite = await prisma.invite.findFirst({
              where: {
                email,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: new Date() },
              },
              orderBy: { createdAt: 'desc' },
            });

            if (pendingInvite) {
              return { data: { ...user, activeOrgId: pendingInvite.orgId } };
            }

            const org = await prisma.organization.create({
              data: { name: deriveOrgName(email) },
            });
            return { data: { ...user, activeOrgId: org.id } };
          },
          after: async (user) => {
            // Pair the user with their org via OrgMembership. If an invite
            // is pending for this email AND points at the user's active
            // org, accept it and use the invite's role. Otherwise this is
            // a fresh signup → role='owner'.
            const u = user as unknown as {
              id: string;
              email: string;
              activeOrgId: string;
            };
            const pendingInvite = await prisma.invite.findFirst({
              where: {
                email: u.email,
                orgId: u.activeOrgId,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: new Date() },
              },
              orderBy: { createdAt: 'desc' },
            });
            if (pendingInvite) {
              await prisma.$transaction([
                prisma.orgMembership.create({
                  data: {
                    userId: u.id,
                    orgId: u.activeOrgId,
                    role: pendingInvite.role,
                  },
                }),
                prisma.invite.update({
                  where: { id: pendingInvite.id },
                  data: { acceptedAt: new Date(), acceptedByUserId: u.id },
                }),
              ]);
              return;
            }
            await prisma.orgMembership.create({
              data: { userId: u.id, orgId: u.activeOrgId, role: 'owner' },
            });
          },
        },
      },
    },
  });
}

function undefinedThrow(message: string): never {
  throw new Error(message);
}
