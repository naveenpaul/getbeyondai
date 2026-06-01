/**
 * Token → cents pricing tables for the Claude models the runtime targets
 * (eng-review pass-1 Issue 6B — cost transparency is a moat-supporting
 * feature, not an afterthought).
 *
 * Pricing is per-million-tokens, USD. We carry input + output rates per
 * model and convert to cents at runtime to keep the math integer-friendly.
 * Anthropic adjusts published rates occasionally — when they change, update
 * this table and bump the version comment so the audit trail reflects what
 * we charged at the time. Rates are exposed via `MODEL_PRICING` so the
 * /audit page can show "$0.034 for 8,200 input / 412 output tokens on
 * sonnet-4-6".
 *
 * Rounding: we use ceil to avoid silent under-billing — a 0.4-cent call
 * costs 1 cent, not 0. Over long runs the impact is sub-percent. Cost
 * displays should treat costCents as a lower bound on US dollars charged.
 */

/** Per-million-token rates in USD as of 2026-05-01. */
export interface ModelRate {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelRate> = {
  // Anthropic published rates (subject to change — see comment above)
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4 },
  // OpenAI published rates (approximate — CONFIRM before relying on billing).
  // Required so a teammate routed to OpenAI (default gpt-4.1 / gpt-4.1-mini)
  // prices its calls instead of throwing UnknownModelError mid-run. Model names
  // are globally unique (claude-* vs gpt-*), so the flat map is unambiguous.
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
};

/**
 * Prompt-cache pricing multipliers, applied to a model's input rate.
 * Anthropic prices a cache write at 1.25× the input rate (one-time, when the
 * cache entry is created) and a cache read at 0.1× (every subsequent hit).
 * These are off the fresh-input rate, which is the standard the input tokens
 * are already billed at, so we reuse `inputPerMillion`.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Compute the cost in cents for one model call. Unknown model names raise —
 * we'd rather fail loudly than silently bill at $0 (which would let a typo
 * masquerade as a free run, breaking the cost-transparency contract).
 *
 * Cache tokens are optional and default to 0, so callers/providers that don't
 * report them (or models without prompt caching) bill exactly as before.
 * Anthropic reports cache_read / cache_creation tokens SEPARATELY from
 * `input_tokens`, so they are added on top, each at its multiplier of the
 * input rate.
 */
export function costCentsForCall(
  modelName: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  const rate = MODEL_PRICING[modelName];
  if (!rate) {
    throw new UnknownModelError(modelName);
  }
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (
    usage.inputTokens < 0 ||
    usage.outputTokens < 0 ||
    cacheRead < 0 ||
    cacheWrite < 0
  ) {
    throw new RangeError(
      `token usage must be non-negative; got input=${usage.inputTokens} ` +
        `output=${usage.outputTokens} cacheRead=${cacheRead} cacheWrite=${cacheWrite}`,
    );
  }
  const inputDollars = (usage.inputTokens / 1_000_000) * rate.inputPerMillion;
  const outputDollars =
    (usage.outputTokens / 1_000_000) * rate.outputPerMillion;
  const cacheReadDollars =
    (cacheRead / 1_000_000) * rate.inputPerMillion * CACHE_READ_MULTIPLIER;
  const cacheWriteDollars =
    (cacheWrite / 1_000_000) * rate.inputPerMillion * CACHE_WRITE_MULTIPLIER;
  // Multiply by 100 → cents. Use ceil so a sub-cent call rounds up to 1 cent
  // (avoid silent under-billing on tiny calls).
  return Math.ceil(
    (inputDollars + outputDollars + cacheReadDollars + cacheWriteDollars) * 100,
  );
}

export class UnknownModelError extends Error {
  constructor(public readonly modelName: string) {
    super(
      `No pricing entry for model "${modelName}". Add it to MODEL_PRICING ` +
        `with the published per-million-token rates.`,
    );
    this.name = 'UnknownModelError';
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly currentCents: number,
    public readonly proposedCents: number,
    public readonly budgetCents: number,
  ) {
    super(
      `Run would exceed cost budget: current=${currentCents}¢, ` +
        `proposed=${proposedCents}¢, budget=${budgetCents}¢`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Enforce the per-run cost cap (plan v1 architecture invariant #8). Call
 * BEFORE making an LLM/tool call when the cost is predictable, or after
 * when it isn't — both modes have legitimate use cases. The exception is
 * caught by the runtime loop and translated into
 * AgentRun.status='abstained' + reason='exceeded_budget'.
 */
export function assertWithinBudget(
  currentCents: number,
  proposedCents: number,
  budgetCents: number,
): void {
  if (currentCents + proposedCents > budgetCents) {
    throw new BudgetExceededError(currentCents, proposedCents, budgetCents);
  }
}
