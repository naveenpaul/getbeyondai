'use client';

import { useSession } from './auth-client';

/**
 * Resolves the current actor's identity for UI display purposes only.
 *
 * The API derives identity from the session cookie via AuthGuard — no
 * client code should pass orgId/userId in request bodies. This hook is
 * solely for showing the user's name/email in the UI.
 */

interface Identity {
  orgId: string;
  userId: string;
  email: string | null;
  name: string | null;
}

interface IdentityState {
  status: 'loading' | 'authenticated' | 'signed_out';
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
      activeOrgId?: string;
    };
    if (user.activeOrgId) {
      return {
        status: 'authenticated',
        identity: {
          orgId: user.activeOrgId,
          userId: user.id,
          email: user.email ?? null,
          name: user.name ?? null,
        },
      };
    }
  }

  return { status: 'signed_out', identity: null };
}
