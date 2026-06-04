/**
 * Sourcing settings HTTP contracts (per-org contact-enrichment config).
 *
 * MIT (@getbeyond/shared) so the web client + extension bind without AGPL.
 *
 * Stage 5 of a prospect search pulls contacts at qualified companies through a
 * connector *waterfall*. These settings let an org tune that waterfall:
 *   - `priority` — the order connectors are tried (the first to satisfy the
 *     threshold wins; later connectors are skipped to save credits).
 *   - `threshold` — the email-verification bar: `verified` chases a verified
 *     email across connectors; `any` accepts the first contact found.
 *
 * Only enrichment connectors (those that source contacts-with-emails) are
 * valid here: ZoomInfo and Snov. The server validates against this set.
 */

import type { ConnectorKind } from './connector-contracts';

/** Connectors that can source contacts in the Stage 5 waterfall. */
export type SourcingConnectorKind = Extract<ConnectorKind, 'zoominfo' | 'snov'>;

/** The email-verification bar applied while sourcing contacts. */
export type SourcingThresholdName = 'verified' | 'any';

// ─── GET /settings/sourcing ─────────────────────────────────────────

export interface SourcingSettingsResponse {
  /** Ordered connector priority for the Stage 5 contact waterfall. */
  priority: SourcingConnectorKind[];
  /** The email-verification bar. */
  threshold: SourcingThresholdName;
  /**
   * The server defaults, surfaced so the client can show "(default)" and reset.
   * The server remains the source of truth.
   */
  defaults: {
    priority: SourcingConnectorKind[];
    threshold: SourcingThresholdName;
  };
}

// ─── PUT /settings/sourcing ─────────────────────────────────────────
//
// Upserts the org's sourcing config. Identity (orgId) is from the session,
// never the body.

export interface SaveSourcingSettingsRequest {
  /**
   * Ordered connector priority. Must contain only valid enrichment connectors,
   * with no duplicates. An empty list means "no contact sourcing".
   */
  priority: SourcingConnectorKind[];
  threshold: SourcingThresholdName;
}
