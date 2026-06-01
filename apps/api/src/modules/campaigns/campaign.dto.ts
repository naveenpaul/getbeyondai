import { z } from 'zod';
import type {
  CampaignDetailResponse,
  CampaignListResponse,
  CreateCampaignRequest,
  CreateCampaignResponse,
} from '@getbeyond/shared';

/**
 * POST /campaigns request body — Zod validator.
 *
 * The public *types* live in @getbeyond/shared so the web client + Chrome
 * extension + third-party clients import them without pulling in the API
 * package. The `satisfies` check below binds the Zod runtime to the same shape
 * so drift fails the build, not a test.
 *
 * Identity (orgId, createdBy) is NOT in the body — the controller derives both
 * from the session via @CurrentUser().
 */
const SourcingConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('contact_list'), listId: z.string().min(1) }),
  z.object({ provider: z.literal('apollo'), reserved: z.literal(true) }),
]);

export const CreateCampaignRequestSchema = z.object({
  goal: z.string().min(1, 'goal is required'),
  title: z.string().min(1).optional(),
  winsListId: z.string().min(1).nullable().optional(),
  sourcing: SourcingConfigSchema,
  budgetCents: z.number().int().min(1).max(100_000).optional(),
}) satisfies z.ZodType<CreateCampaignRequest>;

// Re-export the public types so API call sites import them from the DTO module.
export type {
  CampaignDetailResponse,
  CampaignListResponse,
  CreateCampaignRequest,
  CreateCampaignResponse,
};
