import type { PrismaClient } from '@prisma/client';
import {
  assertWithinBudget,
  BudgetExceededError,
  costCentsForCall,
} from './cost';
import type { LlmProvider } from './llm-provider';
import type {
  CreateMessageResult,
  Message,
  ToolChoice,
  ToolDefinition,
} from './llm-types';
import type { RunEvent } from './run-event-bus';

/**
 * The single LLM chokepoint (plan v1 architecture invariant #3).
 *
 * Every model call in the teammate runtime routes through this function.
 * That gives us one place to:
 *   - log token usage + cost into the audit log (ModelCall row)
 *   - bump AgentRun.costCents + lastBeatAt (heartbeat for the stale-run reaper)
 *   - enforce the per-run hard budget cap (invariant #8)
 *
 * The transport is now a provider-neutral `LlmProvider` (Anthropic, OpenAI,
 * …); callModel is the policy layer that wraps it. No vendor SDK type appears
 * here — only neutral `llm-types` shapes (the SDK lives in `providers/`).
 *
 * Caller passes in:
 *   - the LlmProvider (injected; tests pass a stub)
 *   - prisma (for ModelCall + AgentRun mutations)
 *   - the AgentRun id this call belongs to
 *   - the model + prompt + tools + messages (neutral)
 *   - the budget cap in cents
 *
 * Cost semantics:
 *   - We compute cost AFTER the call (the provider returns the actual token
 *     counts, incl. prompt-cache tokens, in the result). Pre-check guards
 *     against running a call when the run is ALREADY over budget; post-check
 *     guards against this call pushing us over.
 *   - When a call pushes us over budget, we STILL persist the ModelCall row
 *     and bump AgentRun.costCents before throwing. The audit trail needs to
 *     reflect what actually happened, not what we wished happened.
 *   - lastBeatAt is bumped on every call so the stale-run reaper doesn't
 *     prematurely kill long teammate runs that legitimately span minutes.
 */

export interface CallModelParams {
  /** AgentRun.id this call belongs to. */
  runId: string;
  /** Model identifier (must appear in MODEL_PRICING). */
  modelName: string;
  /** System prompt. Providers place it wherever their API expects. */
  systemPrompt: string;
  /** Prior conversation turns (neutral). */
  messages: Message[];
  /** Tools the model can call this turn. Omit for plain text turns. */
  tools?: ToolDefinition[];
  /** Max output tokens. Provider applies its own default when omitted. */
  maxTokens?: number;
  /** Optional tool_choice constraint (e.g. force a specific tool). */
  toolChoice?: ToolChoice;
  /** Hard cost cap for the AgentRun in cents. */
  budgetCents: number;
  /**
   * Optional progress callback. When set, fires `model_call_started` BEFORE
   * the provider call and `model_call_completed` AFTER persistence (with the
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
  /** Neutral provider response — caller dispatches on `content` + `stopReason`. */
  message: CreateMessageResult;
  /** ModelCall.id (link this to ToolCall rows that result from the response). */
  modelCallId: string;
  /** This call's cost in cents. AgentRun.costCents has already been incremented. */
  costCents: number;
}

export async function callModel(
  prisma: PrismaClient,
  provider: LlmProvider,
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

  const message = await provider.createMessage({
    model: params.modelName,
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    tools: params.tools,
    maxTokens: params.maxTokens,
    toolChoice: params.toolChoice,
  });

  const costCents = costCentsForCall(params.modelName, message.usage);

  // Persist ModelCall + bump AgentRun BEFORE the budget post-check. The
  // audit log must reflect what actually happened — including the call that
  // pushed the run over budget.
  const modelCall = await prisma.modelCall.create({
    data: {
      runId: params.runId,
      modelName: params.modelName,
      inputTokens: message.usage.inputTokens,
      outputTokens: message.usage.outputTokens,
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
      inputTokens: message.usage.inputTokens,
      outputTokens: message.usage.outputTokens,
      costCents,
      runCostCents: run.costCents + costCents,
    },
  });

  // Post-check: did this call push us over the cap?
  if (run.costCents + costCents > params.budgetCents) {
    throw new BudgetExceededError(run.costCents, costCents, params.budgetCents);
  }

  return { message, modelCallId: modelCall.id, costCents };
}
