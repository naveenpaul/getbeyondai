import { z } from 'zod';

/**
 * POST /teammates/researcher/run request body.
 *
 * Pre-auth stub: orgId + triggeredBy live in the body. When real auth
 * lands, both come from OrgContext and the DTO shrinks to { target }.
 */
export const ResearcherRunRequestSchema = z.object({
  orgId: z.string().min(1, 'orgId is required'),
  triggeredBy: z.string().min(1, 'triggeredBy is required'),
  target: z.string().min(1, 'target is required'),
  budgetCents: z.number().int().min(1).max(10_000).optional(),
});

export type ResearcherRunRequest = z.infer<typeof ResearcherRunRequestSchema>;

/**
 * Response from POST /teammates/researcher/run. 200 OK — the call is
 * synchronous for v1 (typical run completes in 30-60s, under the request
 * timeout). Async + poll lands later when long-running queries become a
 * thing.
 */
export interface ResearcherRunResponse {
  runId: string;
  status: 'completed' | 'abstained';
  reason?: string;
  draftId?: string;
  costCents: number;
  toolCallCount: number;
}
