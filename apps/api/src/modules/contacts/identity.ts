/**
 * Email normalization for cross-source contact identity (eng-review pass-2 D2 + codex T2).
 *
 * The same person across HubSpot + Apollo + CSV must collapse to ONE Contact row.
 * That requires a deterministic normalization function used by every write path
 * (pull adapters, manual entry, CSV upload, write-back response handlers).
 *
 * Rules:
 *   - Lowercase. RFC 5321 says the local-part is case-sensitive in theory; in
 *     practice every modern provider treats it as case-insensitive. Matching
 *     industry behavior beats matching the spec here.
 *   - Strip Gmail-style `+suffix` from the local-part. `sarah+work@acme.com`
 *     and `sarah@acme.com` are the same identity at every major provider.
 *   - PRESERVE the subdomain. `sarah@mail.acme.com` is NOT `sarah@acme.com`.
 *     Different addresses, often different humans, never merge them.
 *   - Reject malformed input with a typed `InvalidEmailError.reason` that
 *     caller layers (CSV import, adapter sync) use to produce row-level error
 *     reports instead of unwrapping exceptions for control flow.
 *
 * Companion: `pg_advisory_xact_lock(hashtext(orgId), hashtext(normalizedEmail))`
 * wraps the upsert that consumes this output. See `./contact-upsert.ts` (T1b).
 */

export type InvalidEmailReason =
  | 'empty'
  | 'too_long'
  | 'no_at'
  | 'multiple_at'
  | 'invalid_local'
  | 'invalid_domain'
  | 'whitespace_in_local'
  | 'whitespace_in_domain';

export class InvalidEmailError extends Error {
  constructor(
    public readonly reason: InvalidEmailReason,
    public readonly input: string,
  ) {
    super(`Invalid email (${reason}): ${JSON.stringify(input)}`);
    this.name = 'InvalidEmailError';
  }
}

// RFC 5321 §4.5.3.1.3 — max email length is 254 chars.
const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(input: string | null | undefined): string {
  if (input == null) {
    throw new InvalidEmailError('empty', String(input));
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidEmailError('empty', input);
  }

  if (trimmed.length > MAX_EMAIL_LENGTH) {
    throw new InvalidEmailError('too_long', input);
  }

  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount === 0) {
    throw new InvalidEmailError('no_at', input);
  }
  if (atCount > 1) {
    throw new InvalidEmailError('multiple_at', input);
  }

  const atIdx = trimmed.indexOf('@');
  const localRaw = trimmed.slice(0, atIdx);
  const domainRaw = trimmed.slice(atIdx + 1);

  if (!localRaw) {
    throw new InvalidEmailError('invalid_local', input);
  }
  if (!domainRaw) {
    throw new InvalidEmailError('invalid_domain', input);
  }

  if (/\s/.test(localRaw)) {
    throw new InvalidEmailError('whitespace_in_local', input);
  }
  if (/\s/.test(domainRaw)) {
    throw new InvalidEmailError('whitespace_in_domain', input);
  }

  // Strip plus-suffix from local-part. `sarah+anything@acme.com` → `sarah`.
  const plusIdx = localRaw.indexOf('+');
  const localStripped = plusIdx >= 0 ? localRaw.slice(0, plusIdx) : localRaw;

  if (!localStripped) {
    // The `+` consumed everything (e.g. '+work@acme.com').
    throw new InvalidEmailError('invalid_local', input);
  }

  // Domain must have at least one dot (no `sarah@acme` — no TLD).
  if (!domainRaw.includes('.')) {
    throw new InvalidEmailError('invalid_domain', input);
  }

  return `${localStripped.toLowerCase()}@${domainRaw.toLowerCase()}`;
}
