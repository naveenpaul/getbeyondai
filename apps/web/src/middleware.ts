import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * Auth gate (T6.3).
 *
 * Middleware runs at the edge BEFORE any page renders, so we can redirect
 * unauthenticated users without a flash of unauth'd content.
 *
 * better-auth's `getSessionCookie` only checks the cookie's PRESENCE — it
 * doesn't validate the signature (validation requires DB lookup and isn't
 * worth the edge round-trip). The first protected API call rejects an
 * invalid cookie cleanly; the only failure mode here is a malicious user
 * who hand-crafts a cookie and gets to render the page shell before the
 * first API call fails. Acceptable for v1.
 */

const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/', '/login']);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Auth handler routes are public — they ARE the sign-in flow.
  if (pathname.startsWith('/api/auth')) return true;
  // Next internals.
  if (pathname.startsWith('/_next')) return true;
  if (pathname === '/favicon.ico') return true;
  return false;
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const sessionCookie = getSessionCookie(request);
  if (sessionCookie) return NextResponse.next();

  // Redirect to /login with a `next` query so we come back here after sign-in.
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on every request except static assets. The middleware function
  // itself short-circuits public paths above.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
