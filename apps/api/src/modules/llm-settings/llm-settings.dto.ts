import { z } from 'zod';
import type {
  LlmProviderName,
  LlmSettingsResponse,
  SaveLlmCredentialRequest,
  SaveLlmCredentialResponse,
  SaveLlmRoutingRequest,
} from '@getbeyond/shared';

/**
 * LLM settings request bodies — Zod validators.
 *
 * The public *types* live in @getbeyond/shared so the web client + Chrome
 * extension import them without pulling in the API package. The `satisfies`
 * checks bind the Zod runtime to the same shapes so drift fails the build.
 *
 * Identity (orgId) is NEVER in the body — the controller derives it from the
 * session via @CurrentUser().
 */

/** The two providers we route to. Mirrors the shared LlmProviderName union and
 * the Prisma `Provider` enum — kept as a constant so the Zod enum, the GET
 * status list, and the enum mapping all read from one source. */
export const LLM_PROVIDER_NAMES = ['anthropic', 'openai'] as const;

const LlmProviderNameSchema = z.enum(LLM_PROVIDER_NAMES);

export const SaveLlmCredentialRequestSchema = z.object({
  provider: LlmProviderNameSchema,
  apiKey: z.string().min(1, 'apiKey is required'),
}) satisfies z.ZodType<SaveLlmCredentialRequest>;

export const SaveLlmRoutingRequestSchema = z.object({
  teammate: z.string().min(1, 'teammate is required'),
  provider: LlmProviderNameSchema,
  modelPrimary: z.string().min(1).optional(),
  modelFast: z.string().min(1).optional(),
}) satisfies z.ZodType<SaveLlmRoutingRequest>;

// Re-export the public types so API call sites import them from the DTO module.
export type {
  LlmProviderName,
  LlmSettingsResponse,
  SaveLlmCredentialRequest,
  SaveLlmCredentialResponse,
  SaveLlmRoutingRequest,
};
