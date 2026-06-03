/**
 * Per-field precedence resolver (eng-review pass-2 D3 + codex T4 hardening).
 *
 * When a sync brings in new field values for an existing Contact, we don't
 * blindly overwrite: a manual user edit must beat a HubSpot pull, HubSpot must
 * beat Apollo, and a vendor must never null-out a populated field. The pure
 * function `resolveFieldUpdates` answers "for each incoming field, do we
 * apply it?" and returns the new fieldProvenance map alongside the updates.
 *
 * Backend-only. The matching UI affordance ("Allow vendor sync to overwrite")
 * is task T12 (post-launch).
 */

export type SourceTier =
  | 'manual'
  | 'hubspot'
  | 'salesforce'
  | 'apollo'
  | 'zoominfo'
  | 'snov'
  | 'csv';

/**
 * Tier ladder. Higher number = higher precedence.
 *
 *   manual (100)              user-typed; sticky against all vendor sources
 *   hubspot / salesforce 50   system-of-record CRMs (user owns + edits in them)
 *   apollo / zoominfo / snov  25 data vendors (enrichment-only, lower trust)
 *   csv                  10   user-supplied bulk import, no auth, lowest trust
 */
export const TIER_PRECEDENCE: Readonly<Record<SourceTier, number>> = {
  manual: 100,
  hubspot: 50,
  salesforce: 50,
  apollo: 25,
  zoominfo: 25,
  snov: 25,
  csv: 10,
};

export interface FieldProvenanceEntry {
  /** `'manual'` for user edits; ConnectorAccount.id for vendor writes. */
  source: string;
  tier: SourceTier;
  /** ISO-8601. Used for same-tier last-write-wins comparison. */
  updatedAt: string;
}

export type FieldProvenance = Record<string, FieldProvenanceEntry>;

export interface FieldUpdateSource {
  /** ConnectorAccount.id, or the literal string `'manual'` for user edits. */
  accountId: string;
  tier: SourceTier;
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  now?: Date;
}

export interface ResolveFieldUpdatesParams {
  existingProvenance: FieldProvenance;
  incoming: Record<string, string | null | undefined>;
  source: FieldUpdateSource;
}

export interface ResolveFieldUpdatesResult {
  /** Fields to write on the Contact. Keys are subset of `incoming`. */
  updates: Record<string, string | null>;
  /** New fieldProvenance map (existing preserved, updated entries replaced). */
  provenance: FieldProvenance;
}

/**
 * For each incoming field, decide whether to write it based on tier + recency.
 *
 *   - Empty / null / undefined incoming → skip (vendors never null-out data).
 *   - No existing provenance → write incoming.
 *   - Existing tier > incoming tier → skip.
 *   - Existing tier < incoming tier → write incoming.
 *   - Same tier → write iff incoming.now > existing.updatedAt.
 *
 * Pure function. Caller wraps the result in a `contact.update`.
 */
export function resolveFieldUpdates(
  params: ResolveFieldUpdatesParams,
): ResolveFieldUpdatesResult {
  const { existingProvenance, incoming, source } = params;
  const now = (source.now ?? new Date()).toISOString();
  const incomingTier = TIER_PRECEDENCE[source.tier];

  const updates: Record<string, string | null> = {};
  const newProvenance: FieldProvenance = { ...existingProvenance };

  for (const [field, rawValue] of Object.entries(incoming)) {
    const value = rawValue == null || rawValue === '' ? null : rawValue;
    if (value === null) continue;

    const existing = existingProvenance[field];

    if (!existing) {
      updates[field] = value;
      newProvenance[field] = {
        source: source.accountId,
        tier: source.tier,
        updatedAt: now,
      };
      continue;
    }

    const existingTier = TIER_PRECEDENCE[existing.tier];

    if (existingTier > incomingTier) continue;
    if (existingTier < incomingTier) {
      updates[field] = value;
      newProvenance[field] = {
        source: source.accountId,
        tier: source.tier,
        updatedAt: now,
      };
      continue;
    }

    // Same tier — newer wins.
    if (now > existing.updatedAt) {
      updates[field] = value;
      newProvenance[field] = {
        source: source.accountId,
        tier: source.tier,
        updatedAt: now,
      };
    }
  }

  return { updates, provenance: newProvenance };
}

/**
 * Identity mapping from a Prisma ConnectorKind to a SourceTier. Kept as a
 * function (vs a type assertion) so the boundary is explicit and the type
 * checker can spot any future enum drift.
 */
export function tierFromConnectorKind(
  kind: 'hubspot' | 'salesforce' | 'apollo' | 'zoominfo' | 'snov' | 'csv',
): SourceTier {
  return kind;
}
