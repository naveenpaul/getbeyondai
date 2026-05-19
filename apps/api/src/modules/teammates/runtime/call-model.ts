import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import {
  assertWithinBudget,
  BudgetExceededError,
  costCentsForCall,
} from './cost';
import type { RunEvent } from './run-event-bus';

/**
 * The single LLM chokepoint (plan v1 architecture invariant #3).
 *
 * Every Claude API call in the teammate runtime routes through this function.
 * That gives us one place to:
 *   - log token usage + cost into the audit log (ModelCall row)
 *   - bump AgentRun.costCents + lastBeatAt (heartbeat for the stale-run reaper)
 *   - enforce the per-run hard budget cap (invariant #8)
 *   - swap models / providers later without rewriting teammate code
 *
 * Caller passes in:
 *   - the Anthropic client (injected; tests pass a stub)
 *   - prisma (for ModelCall + AgentRun mutations)
 *   - the AgentRun id this call belongs to
 *   - the model + prompt + tools + messages
 *   - the budget cap in cents
 *
 * Cost semantics:
 *   - We compute cost AFTER the call (Anthropic returns the actual token
 *     counts in the response). Pre-check guards against running a call when
 *     the run is ALREADY over budget; post-check guards against this call
 *     pushing us over.
 *   - When a call pushes us over budget, we STILL persist the ModelCall row
 *     and bump AgentRun.costCents before throwing. The audit trail needs to
 *     reflect what actually happened, not what we wished happened.
 *   - lastBeatAt is bumped on every call so the stale-run reaper doesn't
 *     prematurely kill long teammate runs that legitimately span minutes.
 *
 * SDK quarantine: this is the ONLY file in the repo that may import
 * `@anthropic-ai/sdk`. Enforced by dependency-cruiser.
 */

/** Minimal contract that callModel needs — facilitates test stubs. */
export type AnthropicMessagesClient = Pick<Anthropic, 'messages'>;

export interface CallModelParams {
  /** AgentRun.id this call belongs to. */
  runId: string;
  /** Model identifier (must appear in MODEL_PRICING). */
  modelName: string;
  /** System prompt. Anthropic separates this from the message turn array. */
  systemPrompt: string;
  /** Prior conversation turns (user/assistant/tool_result). */
  messages: Anthropic.MessageParam[];
  /** Tools the model can call this turn. Omit for plain text turns. */
  tools?: Anthropic.Tool[];
  /** Anthropic max_tokens. Default 4096. */
  maxTokens?: number;
  /** Optional tool_choice constraint (e.g. force a specific tool). */
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
  /** Hard cost cap for the AgentRun in cents. */
  budgetCents: number;
  /**
   * Optional progress callback. When set, fires `model_call_started` BEFORE
   * the SDK call and `model_call_completed` AFTER persistence (with the
   * real token + cost numbers). No-op default keeps existing call sites
   * working without changes.
   */
  emitEvent?: (event: RunEvent) => void;
  /**
   * Zero-indexed turn number within the loop. Surfaces in the event so
   * the UI can show "Turn 3 of N". The loop bumps this per iteration;
   * direct callers can ignore.
   */
  turn?: number;
}

export interface CallModelResult {
  /** Raw Anthropic response — caller dispatches on `stop_reason` + `content`. */
  message: Anthropic.Message;
  /** ModelCall.id (link this to ToolCall rows that result from the response). */
  modelCallId: string;
  /** This call's cost in cents. AgentRun.costCents has already been incremented. */
  costCents: number;
}

export async function callModel(
  prisma: PrismaClient,
  anthropic: AnthropicMessagesClient,
  params: CallModelParams,
): Promise<CallModelResult> {
  const run = await prisma.agentRun.findUnique({ where: { id: params.runId } });
  if (!run) {
    throw new Error(`AgentRun ${params.runId} not found`);
  }
  // Pre-check: refuse to spend if we're already at or past the cap.
  // Proposed=0 here — we don't know the real cost until after the call.
  assertWithinBudget(run.costCents, 0, params.budgetCents);

  params.emitEvent?.({
    type: 'model_call_started',
    runId: params.runId,
    at: new Date().toISOString(),
    data: { modelName: params.modelName, turn: params.turn ?? 0 },
  });

  const message = await anthropic.messages.create({
    model: params.modelName,
    system: params.systemPrompt,
    messages: params.messages,
    tools: params.tools,
    max_tokens: params.maxTokens ?? 4096,
    tool_choice: params.toolChoice,
  });

  const costCents = costCentsForCall(params.modelName, {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });

  // Persist ModelCall + bump AgentRun BEFORE the budget post-check. The
  // audit log must reflect what actually happened — including the call that
  // pushed the run over budget.
  const modelCall = await prisma.modelCall.create({
    data: {
      runId: params.runId,
      modelName: params.modelName,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      costCents,
    },
  });
  await prisma.agentRun.update({
    where: { id: params.runId },
    data: {
      costCents: { increment: costCents },
      lastBeatAt: new Date(),
    },
  });

  params.emitEvent?.({
    type: 'model_call_completed',
    runId: params.runId,
    at: new Date().toISOString(),
    data: {
      modelCallId: modelCall.id,
      modelName: params.modelName,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      costCents,
      runCostCents: run.costCents + costCents,
    },
  });

  // Post-check: did this call push us over the cap?
  if (run.costCents + costCents > params.budgetCents) {
    throw new BudgetExceededError(
      run.costCents,
      costCents,
      params.budgetCents,
    );
  }

  return { message, modelCallId: modelCall.id, costCents };
}

/**
 * Factory for the singleton Anthropic client. Wired in RuntimeModule;
 * exported here so the SDK import stays in this file.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  if (!apiKey || apiKey === 'change-me-in-production') {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  return new Anthropic({ apiKey });
}

/** DI token for the Anthropic client. */
export const ANTHROPIC_CLIENT = Symbol.for('@getbeyond/anthropic-client');
