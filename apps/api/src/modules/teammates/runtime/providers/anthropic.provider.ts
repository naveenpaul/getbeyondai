import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from '../llm-provider';
import {
  LlmAuthError,
  LlmOverloadedError,
  LlmProviderError,
  LlmRateLimitError,
  type ContentBlock,
  type CreateMessageParams,
  type CreateMessageResult,
  type Message,
  type ProviderCapabilities,
  type StopReason,
  type ToolChoice,
  type ToolDefinition,
  type Usage,
} from '../llm-types';

/**
 * Anthropic provider adapter (LLM provider abstraction — plan P1).
 *
 * SDK QUARANTINE: this is one of the only files allowed to import
 * `@anthropic-ai/sdk` (enforced by dependency-cruiser). It translates the
 * runtime's neutral types to/from the Anthropic Messages API and nothing
 * leaks back out — callers see only neutral `llm-types` shapes.
 *
 * Translation map:
 *
 *   neutral CreateMessageParams ──▶ Anthropic.MessageCreateParams
 *     systemPrompt  ──▶ system: [{ text, cache_control: ephemeral }]   (cached)
 *     tools         ──▶ tools: [...], cache_control on the LAST tool   (cached)
 *     messages      ──▶ messages: content blocks mapped 1:1
 *     toolChoice    ──▶ tool_choice
 *
 *   Anthropic.Message ──▶ neutral CreateMessageResult
 *     content     ──▶ text + tool_use blocks (others ignored)
 *     stop_reason ──▶ StopReason
 *     usage       ──▶ Usage incl. cache_read / cache_creation tokens
 *
 * Caching: the neutral boundary is prompt-cache READY — `Usage` carries
 * cache tokens and `cost.ts` prices them. Actually enabling Anthropic prompt
 * caching (`cache_control` on the system block + tools) requires a newer
 * `@anthropic-ai/sdk` than the pinned 0.30.1, whose stable types predate it.
 * So this adapter does not yet send `cache_control`; flipping it on is a
 * one-line change after the SDK bump (see `capabilities.caching`). We still
 * read any cache tokens the API returns, so cost stays correct if a future
 * SDK/beta starts reporting them.
 */

/** Minimal client surface the provider needs — lets tests inject a stub. */
export type AnthropicMessagesClient = Pick<Anthropic, 'messages'>;

const PROVIDER_NAME = 'anthropic';

/** Usage fields the API may return that the pinned SDK's types don't model. */
interface UsageWithCache {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities = {
    toolUse: true,
    parallelToolUse: true,
    // Anthropic supports prompt caching, but this adapter does not enable it
    // on SDK 0.30.1 (types predate cache_control). Flip to true with the bump.
    caching: false,
  };

  private readonly client: AnthropicMessagesClient;

  constructor(client: AnthropicMessagesClient) {
    this.client = client;
  }

  async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResult> {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.systemPrompt,
      messages: params.messages.map(toAnthropicMessage),
      ...(params.tools && params.tools.length > 0
        ? { tools: toAnthropicTools(params.tools) }
        : {}),
      ...(params.toolChoice
        ? { tool_choice: toAnthropicToolChoice(params.toolChoice) }
        : {}),
    };

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(request);
    } catch (err) {
      throw normalizeError(err);
    }

    return {
      content: fromAnthropicContent(message.content),
      stopReason: fromAnthropicStopReason(message.stop_reason),
      usage: fromAnthropicUsage(message.usage),
      model: message.model,
    };
  }
}

/**
 * Build the singleton provider from an API key. Called by the DI factory.
 * Throws on a missing/placeholder key so app boot fails loudly rather than
 * the first run failing opaquely.
 */
export function createAnthropicProvider(apiKey: string): AnthropicProvider {
  if (!apiKey || apiKey === 'change-me-in-production') {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  return new AnthropicProvider(new Anthropic({ apiKey }));
}

// ───────────────────────── neutral → Anthropic ─────────────────────────

function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
  return {
    role: msg.role,
    content: msg.content.map(toAnthropicBlock),
  };
}

function toAnthropicBlock(
  block: ContentBlock,
):
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));
}

function toAnthropicToolChoice(
  choice: ToolChoice,
): Anthropic.MessageCreateParams['tool_choice'] {
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' };
    case 'any':
      return { type: 'any' };
    case 'tool':
      return { type: 'tool', name: choice.name };
  }
}

// ───────────────────────── Anthropic → neutral ─────────────────────────

function fromAnthropicContent(
  content: Anthropic.ContentBlock[],
): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // Other block kinds (thinking, etc.) are not part of the neutral model
    // and are intentionally dropped — the runtime only acts on text + tool_use.
  }
  return out;
}

function fromAnthropicStopReason(
  reason: Anthropic.Message['stop_reason'],
): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    // 'end_turn' | 'stop_sequence' | null → the model finished its turn.
    default:
      return 'end';
  }
}

function fromAnthropicUsage(usage: Anthropic.Usage): Usage {
  // Cache token fields aren't in SDK 0.30.1's Usage type but the API may
  // return them; read defensively so cost stays correct after an SDK bump.
  const cache = usage as Anthropic.Usage & UsageWithCache;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(cache.cache_read_input_tokens != null
      ? { cacheReadTokens: cache.cache_read_input_tokens }
      : {}),
    ...(cache.cache_creation_input_tokens != null
      ? { cacheWriteTokens: cache.cache_creation_input_tokens }
      : {}),
  };
}

// ───────────────────────────── errors ──────────────────────────────────

function normalizeError(err: unknown): LlmProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return new LlmAuthError(PROVIDER_NAME, err);
    }
    if (status === 429) {
      return new LlmRateLimitError(PROVIDER_NAME, err);
    }
    if (status === 529 || status === 503) {
      return new LlmOverloadedError(PROVIDER_NAME, err);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(
    `Anthropic call failed: ${message}`,
    PROVIDER_NAME,
    err,
  );
}
