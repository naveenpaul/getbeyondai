/**
 * Public env config (T5.3 → T6.4).
 *
 * Only NEXT_PUBLIC_* vars are accessible from browser code. They get baked
 * in at build time, so each value lives here once with explicit fallbacks.
 *
 * Real auth (better-auth, T6) provides orgId + userId via the session
 * cookie. The legacy NEXT_PUBLIC_DEV_ORG_ID / NEXT_PUBLIC_DEV_USER_ID env
 * vars are kept as OPTIONAL fallbacks so the existing seed-dev path keeps
 * working until everyone migrates to logging in, but they're no longer
 * required at module load.
 */

function readPublic(name: string, fallback: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  return fallback;
}

export const env = {
  apiUrl: readPublic('NEXT_PUBLIC_API_URL', 'http://localhost:3000'),
  /** Legacy: empty string means "no fallback, use session". */
  devOrgId: readPublic('NEXT_PUBLIC_DEV_ORG_ID', ''),
  /** Legacy: empty string means "no fallback, use session". */
  devUserId: readPublic('NEXT_PUBLIC_DEV_USER_ID', ''),
};
