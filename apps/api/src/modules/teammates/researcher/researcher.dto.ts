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

/** Returned by POST /teammates/researcher/run. 202 Accepted. */
export interface ResearcherRunEnqueueResponse {
  runId: string;
  status: 'running';
}

/**
 * Returned by GET /teammates/researcher/runs/:id. Caller polls until
 * status is terminal (`completed | abstained | failed`).
 */
export interface ResearcherRunStatusResponse {
  runId: string;
  status: 'running' | 'completed' | 'abstained' | 'failed';
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
  costCents: number;
  toolCallCount: number;
  /** Present once status=completed; null otherwise. */
  draft: {
    id: string;
    type: string;
    content: unknown;
    claims: Array<{
      id: string;
      text: string;
      citationId: string | null;
      citationUrl: string | null;
      abstained: boolean;
      confidence: number | null;
    }>;
  } | null;
}
