'use client';

import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';
import { env } from './env';

/**
 * better-auth client (T6.3).
 *
 * Browser-side counterpart to the server `betterAuth` instance. Exposes:
 *   - signIn.magicLink({ email, callbackURL })
 *   - signOut()
 *   - useSession() — React hook returning { data, isPending, error }
 *
 * The base URL must point at the API's better-auth mount (default
 * /api/auth on the same origin). Direct cross-origin auth requires
 * `credentials: 'include'` on every request — the client handles this.
 */
export const authClient = createAuthClient({
  baseURL: `${env.apiUrl}/api/auth`,
  plugins: [magicLinkClient()],
});

export const { signIn, signOut, useSession } = authClient;
