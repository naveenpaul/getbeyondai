import type { CandidateCompany } from './sourcing-provider';
import { normalizeCompanyName, normalizeDomain } from './normalize';

/**
 * Exclude-wins suppression for search-discovery (review #1).
 *
 * Discovery is "find companies LIKE my winners that I do NOT already own", so any
 * discovered company that is already in the uploaded wins list must be dropped —
 * BEFORE the expensive research/score steps, so we never spend tokens qualifying
 * a company we'd suppress. Matching is on DOMAIN **or** NAME (the name match is
 * the guard for the residual case where a candidate's domain couldn't be
 * resolved): a candidate is suppressed if its normalized domain matches a win's
 * domain, OR its normalized name matches a win's name.
 *
 * Pure + total. The caller resolves candidate domains upstream (inline in the
 * provider) so domain matching actually bites; name matching covers the rest.
 */

/** The minimal win identity we match against (from the wins ContactList). */
export interface WinKey {
  name: string;
  /** Present when the wins list carried a domain; usually null (names only). */
  domain?: string | null;
}

export interface ExcludeWinsResult {
  /** Candidates NOT in the wins list — the ones to qualify. */
  kept: CandidateCompany[];
  /** Candidates suppressed because they matched a win (for logging/telemetry). */
  excluded: CandidateCompany[];
}

/**
 * Partition `candidates` into kept vs. excluded against the `wins` set. A
 * candidate is excluded iff its normalized domain OR normalized name matches any
 * win. Wins with neither a usable name nor domain contribute nothing.
 */
export function excludeWins(
  candidates: ReadonlyArray<CandidateCompany>,
  wins: ReadonlyArray<WinKey>,
): ExcludeWinsResult {
  const winDomains = new Set<string>();
  const winNames = new Set<string>();
  for (const w of wins) {
    const d = normalizeDomain(w.domain);
    if (d) winDomains.add(d);
    const n = normalizeCompanyName(w.name);
    if (n) winNames.add(n);
  }

  const kept: CandidateCompany[] = [];
  const excluded: CandidateCompany[] = [];
  for (const c of candidates) {
    const d = normalizeDomain(c.domain);
    const n = normalizeCompanyName(c.name);
    const isWin = (d !== null && winDomains.has(d)) || (n !== null && winNames.has(n));
    (isWin ? excluded : kept).push(c);
  }
  return { kept, excluded };
}
