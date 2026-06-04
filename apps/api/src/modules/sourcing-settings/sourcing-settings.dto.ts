import { z } from 'zod';
import type {
  SaveSourcingSettingsRequest,
  SourcingSettingsResponse,
  SourcingConnectorKind,
  SourcingThresholdName,
} from '@getbeyond/shared';

/**
 * Sourcing settings request body — Zod validator.
 *
 * The public *types* live in @getbeyond/shared so the web client + extension
 * import them without the API package. The `satisfies` check binds the Zod
 * runtime to the same shape so drift fails the build.
 *
 * Identity (orgId) is NEVER in the body — the controller derives it from the
 * session via @CurrentUser().
 */

/** Enrichment connectors valid in the Stage 5 waterfall (one source of truth). */
export const SOURCING_CONNECTOR_KINDS = ['zoominfo', 'snov'] as const;
export const SOURCING_THRESHOLDS = ['verified', 'any'] as const;

const SourcingConnectorKindSchema = z.enum(SOURCING_CONNECTOR_KINDS);

export const SaveSourcingSettingsRequestSchema = z.object({
  // Ordered priority; only enrichment connectors, no duplicates. Empty = "no
  // contact sourcing" (a valid, deliberate choice).
  priority: z
    .array(SourcingConnectorKindSchema)
    .refine(
      (arr) => new Set(arr).size === arr.length,
      'priority must not contain duplicate connectors',
    ),
  threshold: z.enum(SOURCING_THRESHOLDS),
}) satisfies z.ZodType<SaveSourcingSettingsRequest>;

// Re-export the public types so API call sites import them from the DTO module.
export type {
  SaveSourcingSettingsRequest,
  SourcingSettingsResponse,
  SourcingConnectorKind,
  SourcingThresholdName,
};
