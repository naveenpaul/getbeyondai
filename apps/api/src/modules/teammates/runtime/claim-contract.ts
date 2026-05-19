import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

/**
 * The `emit_draft` claim contract (plan v1 architecture invariant #4 +
 * eng-review Issue 3A — structured Anthropic tool-use output).
 *
 * Every teammate's final synthesis step is an `emit_draft` tool call.
 * The runtime:
 *   1. Validates the args via Zod at the SDK boundary. Malformed args ⇒ the
 *      tool call is reported as a failure to the model, which retries.
 *   2. Drops claims that lack a citation_id AND aren't abstained. This is
 *      the trust mechanic: there is no path to a persisted hallucinated
 *      claim because the database never sees one.
 *   3. Verifies every citation_id references a Citation row actually
 *      created during this AgentRun (no fabricated IDs).
 *   4. Persists Draft + Claims atomically inside a transaction.
 *
 * If you change this file, expect the trust positioning to wobble.
 * Treat it like the SQL that owns user data — every diff needs a test.
 */

export const DraftTypeSchema = z.enum([
  'research_brief',
  'email',
  'linkedin_dm',
  'linkedin_post',
  'twitter_post',
]);
export type DraftTypeSchemaT = z.infer<typeof DraftTypeSchema>;

/**
 * Single claim shape. The model MUST set either:
 *   - `citationId` to a real Citation.id created earlier in this run, OR
 *   - `abstained: true` (signalling "the model couldn't find a source").
 *
 * Claims with citationId=null AND abstained=false are silently dropped at
 * persistence (and counted in the drop report). We don't reject the whole
 * draft because the model occasionally gets ONE claim wrong; dropping the
 * bad claim while keeping the rest is the user-friendly behavior. The drop
 * report surfaces to the audit log.
 */
export const ClaimSchema = z.object({
  text: z.string().min(1, 'claim.text must be non-empty'),
  citationId: z.string().nullable(),
  abstained: z.boolean().default(false),
  confidence: z.number().min(0).max(1).optional(),
});
export type ClaimInput = z.infer<typeof ClaimSchema>;

/**
 * Full emit_draft tool args. `content` is loosely-typed Json because the
 * exact shape varies by `type` (email has {subject, body}; research_brief
 * has {headline, summary, sections}; etc.). The teammate prompts constrain
 * the model output; we don't double-check structure here.
 */
export const EmitDraftArgsSchema = z.object({
  type: DraftTypeSchema,
  content: z.record(z.unknown()),
  claims: z
    .array(ClaimSchema)
    .min(1, 'emit_draft must include at least one claim'),
});
export type EmitDraftArgs = z.infer<typeof EmitDraftArgsSchema>;

export interface ClaimPersistenceResult {
  /** id of the persisted Draft row. */
  draftId: string;
  /** Number of claims persisted (passed the drop-uncited filter). */
  persistedClaimCount: number;
  /** Claims silently dropped because of the no-citation rule. */
  droppedUncitedCount: number;
  /** Claims rejected because they referenced a citationId not in this run. */
  droppedDanglingCount: number;
}

export class ClaimContractError extends Error {
  constructor(
    public readonly code:
      | 'no_valid_claims'
      | 'malformed_args'
      | 'run_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ClaimContractError';
  }
}

/**
 * Persist a Draft + its Claims from a validated `emit_draft` tool call.
 *
 * The drop rules run BEFORE the DB transaction so we don't open a tx that
 * we may end up rolling back. The actual insert is wrapped in a tx so a
 * Draft + Claims either all land or none do.
 *
 * Returns counts so the caller (the tool-use loop) can log them on the
 * AgentRun for the /audit page.
 */
export async function persistDraftFromEmitArgs(
  prisma: PrismaClient,
  params: {
    runId: string;
    orgId: string;
    teammate: string;
    args: EmitDraftArgs;
  },
): Promise<ClaimPersistenceResult> {
  // Whitelist of citation IDs created during this run. Used to reject
  // hallucinated citationIds the model might emit.
  const realCitations = await prisma.citation.findMany({
    where: { runId: params.runId },
    select: { id: true },
  });
  const validIds = new Set(realCitations.map((c) => c.id));

  let droppedUncited = 0;
  let droppedDangling = 0;
  const surviving: ClaimInput[] = [];

  for (const claim of params.args.claims) {
    if (claim.citationId === null) {
      if (claim.abstained) {
        surviving.push(claim);
      } else {
        droppedUncited++;
      }
      continue;
    }
    if (!validIds.has(claim.citationId)) {
      droppedDangling++;
      continue;
    }
    surviving.push(claim);
  }

  if (surviving.length === 0) {
    throw new ClaimContractError(
      'no_valid_claims',
      `emit_draft dropped to zero claims after enforcement ` +
        `(uncited=${droppedUncited}, dangling=${droppedDangling}). ` +
        `Run ${params.runId} cannot produce a Draft.`,
    );
  }

  const draft = await prisma.$transaction(async (tx) => {
    const created = await tx.draft.create({
      data: {
        orgId: params.orgId,
        teammate: params.teammate,
        runId: params.runId,
        type: params.args.type,
        content: params.args.content as Prisma.InputJsonValue,
        status: 'pending',
        claims: {
          create: surviving.map((c) => ({
            text: c.text,
            citationId: c.citationId,
            abstained: c.abstained,
            confidence: c.confidence,
          })),
        },
      },
    });
    // Link AgentRun.outputDraftId for the /audit page.
    await tx.agentRun.update({
      where: { id: params.runId },
      data: { outputDraftId: created.id },
    });
    return created;
  });

  return {
    draftId: draft.id,
    persistedClaimCount: surviving.length,
    droppedUncitedCount: droppedUncited,
    droppedDanglingCount: droppedDangling,
  };
}

/**
 * Anthropic tool definition for emit_draft. Plug this into the `tools` array
 * passed to callModel. Teammate prompts should instruct the model to call
 * this exactly once at the end of every run.
 */
export const EMIT_DRAFT_TOOL = {
  name: 'emit_draft',
  description:
    'Emit the final draft. Every claim MUST cite a Citation id that was ' +
    'created earlier in this run (via fetch_url, brave_search, etc.) OR ' +
    'set abstained=true to signal "no source available". The runtime will ' +
    'drop any claim that lacks a citation and is not abstained.',
  input_schema: {
    type: 'object',
    required: ['type', 'content', 'claims'],
    properties: {
      type: {
        type: 'string',
        enum: [
          'research_brief',
          'email',
          'linkedin_dm',
          'linkedin_post',
          'twitter_post',
        ],
      },
      content: { type: 'object' },
      claims: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1 },
            citationId: { type: ['string', 'null'] },
            abstained: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
} as const;
