/**
 * Test-only session helper (T7.2).
 *
 * Drives the actual magic-link flow against the running auth instance so
 * tests exercise the same code paths as production:
 *   1. POST /sign-in/magic-link → creates Verification + invokes the
 *      sendMagicLink hook (no-op in test env)
 *   2. Read the token from the Verification table directly
 *   3. GET /magic-link/verify?token=… → mints a Session, returns Set-Cookie
 *   4. Convert the Set-Cookie response header to a request Cookie header
 *      via better-auth's own `convertSetCookieToCookie` helper
 *
 * Returns the cookie string ready to drop into
 * `app.inject({ headers: { cookie } })`. Also returns the resolved userId
 * + orgId so tests can assert against the row that was just created.
 */

import type { PrismaClient } from '@prisma/client';
import type { createAuth } from './auth.config';

/**
 * Convert a Set-Cookie response header into a Cookie request header.
 * Inlined (vs importing from `better-auth/test`) because the API tsconfig's
 * `moduleResolution: "Node"` algorithm doesn't follow better-auth's
 * `exports` subpath map.
 *
 * Trims the `Path=`, `HttpOnly`, `Max-Age=`, etc. attributes and keeps
 * only `name=value` pairs joined with `;`.
 */
function setCookieToCookie(headers: Headers): string {
  const setCookies =
    'getSetCookie' in headers && typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie')?.split(/, (?=[^;]+=[^;]+)/) ?? []);
  const pairs: string[] = [];
  for (const sc of setCookies) {
    const firstPair = sc.split(';')[0]?.trim();
    if (firstPair) pairs.push(firstPair);
  }
  return pairs.join('; ');
}

export interface TestSessionResult {
  cookie: string;
  userId: string;
  orgId: string;
}

export async function createTestSession(
  prisma: PrismaClient,
  auth: ReturnType<typeof createAuth>,
  email: string,
): Promise<TestSessionResult> {
  const callbackURL = 'http://localhost:3001/research/new';

  // Step 1: trigger the magic link. In test env sendMagicLink is a no-op
  // (auth.config.ts) — the token still lands in Verification.
  await auth.api.signInMagicLink({
    body: { email, callbackURL },
    headers: new Headers(),
  });

  // Step 2: read the freshest token for this email.
  const verification = await prisma.verification.findFirst({
    where: { identifier: email },
    orderBy: { createdAt: 'desc' },
  });
  if (!verification) {
    throw new Error(
      `createTestSession: expected a Verification row for ${email}`,
    );
  }

  // Step 3: verify → Set-Cookie. asResponse:true gives us the raw Response.
  const verifyResponse = await auth.api.magicLinkVerify({
    query: { token: verification.value, callbackURL },
    headers: new Headers(),
    asResponse: true,
  });

  // Step 4: Set-Cookie → Cookie header.
  const cookie = setCookieToCookie(verifyResponse.headers);
  if (!cookie) {
    throw new Error(
      `createTestSession: magic-link verify did not set a session cookie ` +
        `(status=${verifyResponse.status})`,
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`createTestSession: User row not found for ${email}`);
  }

  return { cookie, userId: user.id, orgId: user.activeOrgId };
}
