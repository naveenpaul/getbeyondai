import { z } from 'zod';
import type {
  ProspectSearchDetailResponse,
  ProspectSearchListResponse,
  CreateProspectSearchRequest,
  CreateProspectSearchResponse,
} from '@getbeyond/shared';

/**
 * POST /prospect-searches request body — Zod validator.
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
  // Apollo discovery takes no extra config — the derived ICP is the query.
  z.object({ provider: z.literal('apollo') }),
]);

/**
 * Explicit ICP overrides. Every field is optional — an omitted field means
 * "let the model derive it"; a provided value overrides the derived one. Employee
 * counts are `.nonnegative()` (a negative headcount is nonsense) and nullable so
 * the client can explicitly clear a bound.
 */
const IcpCriteriaInputSchema = z.object({
  keywords: z.array(z.string().min(1)).optional(),
  employeeCountMin: z.number().int().nonnegative().nullable().optional(),
  employeeCountMax: z.number().int().nonnegative().nullable().optional(),
  fundingStages: z.array(z.string().min(1)).optional(),
  industries: z.array(z.string().min(1)).optional(),
  locations: z.array(z.string().min(1)).optional(),
});

export const CreateProspectSearchRequestSchema = z.object({
  goal: z.string().min(1, 'goal is required'),
  title: z.string().min(1).optional(),
  winsListId: z.string().min(1).nullable().optional(),
  // Optional: a prospectSearch can start with just a goal (derives + shows the ICP,
  // then prompts for a source). Attach a list to find prospects.
  sourcing: SourcingConfigSchema.nullable().optional(),
  // Optional explicit ICP constraints; each provided field overrides what the
  // model would derive from the goal + wins.
  icpCriteria: IcpCriteriaInputSchema.nullable().optional(),
  budgetCents: z.number().int().min(1).max(100_000).optional(),
}) satisfies z.ZodType<CreateProspectSearchRequest>;

// Re-export the public types so API call sites import them from the DTO module.
export type {
  ProspectSearchDetailResponse,
  ProspectSearchListResponse,
  CreateProspectSearchRequest,
  CreateProspectSearchResponse,
};
