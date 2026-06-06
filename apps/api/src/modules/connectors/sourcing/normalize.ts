/**
 * Shared, pure normalization for company identity matching in the sourcing
 * layer — used by search-discovery's exclude-wins suppression (and a candidate
 * for de-duplicating the three existing `toDomain`/`normalizeDomain` copies in
 * the snov/pdl/zoominfo adapters; see the TODO at the bottom).
 *
 * Identity matching has two keys:
 *   - DOMAIN  — the strong key. `https://www.Acme.com/about` → `acme.com`.
 *   - NAME    — the fallback key when a domain can't be resolved. Lowercased,
 *               legal-suffix-stripped, punctuation-folded, so "Acme, Inc." and
 *               "acme" collapse to the same token.
 *
 * Pure + total: blank/garbage in → `null` out. No I/O, no Date, fully unit-testable.
 */

/**
 * Bare registrable hostname from a URL/website string, or null.
 * `"https://www.Acme.com/about?x=1#y"` → `"acme.com"`. Strips scheme, leading
 * `www.`, path, query, and fragment. Does NOT strip multi-level subdomains
 * (e.g. `blog.acme.com` stays) — that's a heuristic we don't want for identity.
 */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (s === '') return null;
  s = s
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .split('?')[0]!
    .split('#')[0]!;
  return s.length > 0 ? s : null;
}

/** Legal-entity suffixes stripped before name comparison (lowercased, no dots). */
const COMPANY_SUFFIXES: readonly string[] = [
  'inc',
  'incorporated',
  'llc',
  'l l c',
  'ltd',
  'limited',
  'pvt',
  'private',
  'private limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'sa',
  'ag',
  'bv',
  'srl',
  'pte',
  'llp',
];

/**
 * Normalize a company name to a comparison token, or null when nothing
 * meaningful remains. Lowercases, strips punctuation to spaces, collapses
 * whitespace, then drops trailing legal-entity suffixes ("Acme, Inc." →
 * "acme"). Conservative: only TRAILING suffix words are removed, so
 * "Co-op Software" keeps "co" (it's not trailing) — we don't want to mangle
 * names whose suffix word is part of the brand.
 */
export function normalizeCompanyName(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  // Punctuation → space (keep alphanumerics + spaces), lowercase, collapse.
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (base === '') return null;

  let words = base.split(' ');
  // Strip trailing legal-entity suffix words (possibly several: "x pvt ltd").
  while (words.length > 1) {
    const last = words[words.length - 1]!;
    if (COMPANY_SUFFIXES.includes(last)) {
      words = words.slice(0, -1);
    } else {
      break;
    }
  }
  const out = words.join(' ').trim();
  return out.length > 0 ? out : null;
}

// TODO(dry): snov.source.ts:410, pdl-sourcing.provider.ts:291, and
// zoominfo-sourcing.provider.ts:318 each carry a near-identical domain
// normalizer. Point them at `normalizeDomain` here in a follow-up cleanup
// (out of scope for the search-discovery build to avoid touching shipped
// adapters in the same diff).
