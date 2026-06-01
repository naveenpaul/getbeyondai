/**
 * Provider-neutral LLM types (LLM provider abstraction — plan P1).
 *
 * These types are the vocabulary every teammate-runtime caller speaks. NO
 * vendor SDK type (`@anthropic-ai/sdk`, `openai`) may appear outside the
 * `providers/` directory — callers (`call-model.ts`, `tool-use-loop.ts`) and
 * services depend ONLY on the shapes here. Each provider adapter translates
 * between these neutral shapes and its vendor wire format.
 *
 * The model is intentionally a superset shaped like Anthropic's content-block
 * model (the richer of the two we support). The OpenAI adapter down-converts
 * (content blocks → `tool_calls` + `role:tool` messages); nothing here is lost
 * to a lowest-common-denominator shape.
 *
 *   ┌─────────────── neutral (this file) ───────────────┐
 *   Message { role, content: ContentBlock[] }
 *     ContentBlock = text | tool_use | tool_result
 *   ToolDefinition { name, description, inputSchema }
 *   Usage { inputTokens, outputTokens, cacheRead?, cacheWrite? }
 *   StopReason = 'tool_use' | 'end' | 'max_tokens'
 *   └───────────────────────────────────────────────────┘
 */

/**
 * One block of message content. `text` and `tool_use` appear in assistant
 * output; `tool_result` appears only in the user turn that answers a prior
 * `tool_use`. The union is shared so a single `Message.content` array can
 * carry whichever blocks a turn needs.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      /** The `tool_use.id` this result answers. */
      toolUseId: string;
      /** Stringified tool output fed back to the model. */
      content: string;
      /** Tool reported/raised an error — the model should adapt. */
      isError: boolean;
    };

/** A single conversation turn. */
export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** Tool the model may invoke this turn. `inputSchema` is JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * Constrains which tool (if any) the model may call this turn.
 *   - auto: model decides (default)
 *   - any:  model must call some tool
 *   - tool: model must call exactly `name`
 */
export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

/**
 * Token usage for one call. Cache tokens are optional because only some
 * providers (Anthropic prompt caching) report them. When present they feed
 * cost accounting so cached calls bill correctly; when absent they default to
 * 0 and cost is unchanged.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the prompt cache (cheaper than fresh input). */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache (slightly dearer than fresh input). */
  cacheWriteTokens?: number;
}

/**
 * Why the model stopped. Normalized across vendors:
 *   - tool_use:   model wants to call a tool (Anthropic 'tool_use' / OpenAI 'tool_calls')
 *   - end:        model finished its turn (Anthropic 'end_turn'|'stop_sequence' / OpenAI 'stop')
 *   - max_tokens: hit the output cap (Anthropic 'max_tokens' / OpenAI 'length')
 */
export type StopReason = 'tool_use' | 'end' | 'max_tokens';

/** Inputs to one model call, vendor-neutral. */
export interface CreateMessageParams {
  /** Model identifier (vendor-specific string; must appear in cost pricing). */
  model: string;
  /** System prompt. Providers place it wherever their API expects. */
  systemPrompt: string;
  /** Prior conversation turns. */
  messages: Message[];
  /** Tools the model can call this turn. Omit for plain-text turns. */
  tools?: ToolDefinition[];
  /** Max output tokens. Provider applies its own default when omitted. */
  maxTokens?: number;
  /** Optional tool-choice constraint. */
  toolChoice?: ToolChoice;
}

/** Result of one model call, vendor-neutral. */
export interface CreateMessageResult {
  /** Assistant output blocks (text + tool_use). */
  content: ContentBlock[];
  /** Normalized stop reason. */
  stopReason: StopReason;
  /** Token usage for cost accounting. */
  usage: Usage;
  /** Model that produced the response (echoed for the audit log). */
  model: string;
}

/**
 * What a provider/model supports. Asserted at run start (fail-fast) so a
 * self-hoster who points the runtime at a model lacking, e.g., tool use gets
 * a clear up-front error instead of a confusing mid-run failure.
 */
export interface ProviderCapabilities {
  /** Model can be given tools and emit tool_use. */
  toolUse: boolean;
  /** Model can emit multiple tool_use blocks in one turn. */
  parallelToolUse: boolean;
  /** Provider supports prompt caching (Anthropic cache_control). */
  caching: boolean;
}

/**
 * Neutral provider error hierarchy. Adapters catch vendor SDK errors and
 * rethrow one of these so vendor error types never escape the `providers/`
 * boundary (the same quarantine that applies to SDK request/response types).
 * No retry is performed (declined in plan review) — these are terminal.
 */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    /** Provider that raised it, for the audit log / operator triage. */
    public readonly provider: string,
    /** Original error, retained for logging (never re-surfaced as a vendor type). */
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

/** Bad, missing, or rotated API key (HTTP 401/403). */
export class LlmAuthError extends LlmProviderError {
  constructor(provider: string, cause?: unknown) {
    super(`LLM auth failed for provider "${provider}"`, provider, cause);
    this.name = 'LlmAuthError';
  }
}

/** Rate limited (HTTP 429). */
export class LlmRateLimitError extends LlmProviderError {
  constructor(provider: string, cause?: unknown) {
    super(`LLM rate limit hit for provider "${provider}"`, provider, cause);
    this.name = 'LlmRateLimitError';
  }
}

/** Provider overloaded / transient upstream failure (HTTP 529/503). */
export class LlmOverloadedError extends LlmProviderError {
  constructor(provider: string, cause?: unknown) {
    super(`LLM provider "${provider}" overloaded`, provider, cause);
    this.name = 'LlmOverloadedError';
  }
}

/** Capability assertion failed at run start (e.g. model lacks tool use). */
export class LlmCapabilityError extends LlmProviderError {
  constructor(provider: string, message: string) {
    super(message, provider);
    this.name = 'LlmCapabilityError';
  }
}
