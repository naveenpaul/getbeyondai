import type { ConnectorKind } from '@prisma/client';
import type {
  SourcingConnectorKind,
  SourcingThresholdName,
} from '@getbeyond/shared';
import type { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Per-org tuning for the Stage 5 contact-sourcing waterfall.
 *
 * The waterfall tries enrichment connectors in `priority` order and stops once
 * the `threshold` is met (saving credits on later connectors). This config is
 * resolved per run from the org's `OrgSourcingConfig` row; absence of a row =
 * the built-in defaults, so an org that never touched these settings behaves
 * exactly as it did before this existed.
 */

export interface ResolvedSourcingConfig {
  /** Ordered enrichment connectors to try (validated to the enrichment set). */
  priority: SourcingConnectorKind[];
  threshold: SourcingThresholdName;
}

/**
 * The connectors that can actually source contacts-with-emails in Stage 5.
 * Discovery-only / CRM connectors (apollo, hubspot, …) are NOT valid here — they
 * don't return verified-email contacts — so they're filtered out of any stored
 * priority list defensively (the settings write path also rejects them).
 */
export const ENRICHMENT_CONNECTOR_KINDS: readonly SourcingConnectorKind[] = [
  'zoominfo',
  'snov',
];

/**
 * Built-in defaults (eng-review A3): ZoomInfo first (stronger verification for
 * the verified-chase), then Snov; chase a verified email.
 */
export const DEFAULT_SOURCING_CONFIG: ResolvedSourcingConfig = {
  priority: ['zoominfo', 'snov'],
  threshold: 'verified',
};

/** Narrow a raw ConnectorKind to a valid enrichment kind (or null). */
function asEnrichmentKind(kind: ConnectorKind): SourcingConnectorKind | null {
  return (ENRICHMENT_CONNECTOR_KINDS as readonly string[]).includes(kind)
    ? (kind as SourcingConnectorKind)
    : null;
}

/**
 * Resolve the org's effective sourcing config. No row → defaults. A row with an
 * empty `contactPriority` is a deliberate "no contact sourcing" choice and is
 * returned as-is (empty), NOT replaced with defaults — the distinction between
 * "never configured" (no row) and "configured to source nothing" (row, []) is
 * meaningful. Stored priority is filtered to valid enrichment kinds so a stale /
 * hand-edited row can never inject a non-enrichment connector into the waterfall.
 */
export async function resolveOrgSourcingConfig(
  prisma: PrismaService,
  orgId: string,
): Promise<ResolvedSourcingConfig> {
  const row = await prisma.orgSourcingConfig.findUnique({
    where: { orgId },
    select: { contactPriority: true, contactThreshold: true },
  });
  if (!row) return DEFAULT_SOURCING_CONFIG;
  return {
    priority: row.contactPriority
      .map(asEnrichmentKind)
      .filter((k): k is SourcingConnectorKind => k !== null),
    threshold: row.contactThreshold,
  };
}
