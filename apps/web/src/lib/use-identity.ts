'use client';

import { useSession } from './auth-client';
import { env } from './env';

/**
 * Resolves the current actor's identity for API calls (T6.4).
 *
 * Returns:
 *   - `orgId` + `userId` from the better-auth session when signed in
 *   - the dev fallbacks from env (NEXT_PUBLIC_DEV_*) when not signed in
 *     AND the fallbacks are set — useful when running against the seed-dev
 *     path without going through the magic-link flow
 *   - null + `loading` while better-auth's session check is in flight
 *   - null + `signedOut` when neither session nor fallback is available
 *
 * This is the only place that should know about both sources. Components
 * call this and treat the result as a single source of truth.
 */

interface Identity {
  orgId: string;
  userId: string;
  email: string | null;
  name: string | null;
}

interface IdentityState {
  status: 'loading' | 'authenticated' | 'fallback' | 'signed_out';
  identity: Identity | null;
}

export function useIdentity(): IdentityState {
  const session = useSession();

  if (session.isPending) {
    return { status: 'loading', identity: null };
  }

  if (session.data) {
    const user = session.data.user as {
      id: string;
      email?: string | null;
      name?: string | null;
      orgId?: string;
    };
    if (user.orgId) {
      return {
        status: 'authenticated',
        identity: {
          orgId: user.orgId,
          userId: user.id,
          email: user.email ?? null,
          name: user.name ?? null,
        },
      };
    }
  }

  // No session — fall back to env-derived dev identity if present.
  if (env.devOrgId && env.devUserId) {
    return {
      status: 'fallback',
      identity: {
        orgId: env.devOrgId,
        userId: env.devUserId,
        email: null,
        name: null,
      },
    };
  }

  return { status: 'signed_out', identity: null };
}
