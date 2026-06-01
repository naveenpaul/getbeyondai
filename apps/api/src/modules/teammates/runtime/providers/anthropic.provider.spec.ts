import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicProvider,
  createAnthropicProvider,
  type AnthropicMessagesClient,
} from './anthropic.provider';
import {
  LlmAuthError,
  LlmOverloadedError,
  LlmProviderError,
  LlmRateLimitError,
  type CreateMessageParams,
  type Message,
} from '../llm-types';

/**
 * Characterization tests for the Anthropic adapter (LLM provider abstraction
 * — plan P1, decision #9).
 *
 * The call-model + tool-use-loop specs were rewritten against neutral types,
 * so they can't prove "the Anthropic wire behavior didn't change" during the
 * migration. THIS spec is that proof: it pins the exact `messages.create`
 * request the adapter builds from neutral params, and the exact neutral
 * result it derives from an Anthropic response. If the mapping drifts, these
 * fail.
 */

/** Build a stub Anthropic client whose create() returns `response`. */
function makeClient(
  response: Anthropic.Message,
  create = vi.fn(async () => response),
): { client: AnthropicMessagesClient; create: typeof create } {
  return {
    client: { messages: { create } as unknown as Anthropic['messages'] },
    create,
  };
}

/** Minimal Anthropic.Message for response-mapping assertions. */
function anthropicMessage(
  partial: Partial<Anthropic.Message> & {
    content: Anthropic.Message['content'];
  },
): Anthropic.Message {
  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...partial,
  } as Anthropic.Message;
}

const BASE_PARAMS: CreateMessageParams = {
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a researcher.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

describe('AnthropicProvider — neutral → Anthropic request mapping', () => {
  it('maps model, default max_tokens, string system, and messages', async () => {
    const { client, create } = makeClient(
      anthropicMessage({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await new AnthropicProvider(client).createMessage(BASE_PARAMS);

    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: 'You are a researcher.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('honors explicit maxTokens', async () => {
    const { client, create } = makeClient(
      anthropicMessage({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await new AnthropicProvider(client).createMessage({
      ...BASE_PARAMS,
      maxTokens: 1024,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 1024 }),
    );
  });

  it('maps tools to input_schema and tool_choice', async () => {
    const { client, create } = makeClient(
      anthropicMessage({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await new AnthropicProvider(client).createMessage({
      ...BASE_PARAMS,
      tools: [
        {
          name: 'brave_search',
          description: 'web search',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      toolChoice: { type: 'tool', name: 'brave_search' },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          {
            name: 'brave_search',
            description: 'web search',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { type: 'tool', name: 'brave_search' },
      }),
    );
  });

  it('omits tools and tool_choice when not provided', async () => {
    const { client, create } = makeClient(
      anthropicMessage({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await new AnthropicProvider(client).createMessage(BASE_PARAMS);
    const arg = (create.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
      string,
      unknown
    >;
    expect(arg).not.toHaveProperty('tools');
    expect(arg).not.toHaveProperty('tool_choice');
  });

  it('maps auto / any tool_choice', async () => {
    const { client, create } = makeClient(
      anthropicMessage({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const provider = new AnthropicProvider(client);
    await provider.createMessage({ ...BASE_PARAMS, toolChoice: { type: 'auto' } });
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ tool_choice: { type: 'auto' } }),
    );
    await provider.createMessage({ ...BASE_PARAMS, toolChoice: { type: 'any' } });
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ tool_choice: { type: 'any' } }),
    );
  });

  it('maps assistant tool_use and tool_result blocks to Anthropic shape', async () => {
    const { client, create } = makeClient(
      anthropicMessage({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'brave_search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            content: 'search failed',
            isError: true,
          },
        ],
      },
    ];
    await new AnthropicProvider(client).createMessage({ ...BASE_PARAMS, messages });

    const arg = (create.mock.calls[0] as unknown[] | undefined)?.[0] as Anthropic.MessageCreateParams;
    expect(arg.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'brave_search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: 'search failed',
            is_error: true,
          },
        ],
      },
    ]);
  });
});

describe('AnthropicProvider — Anthropic → neutral response mapping', () => {
  it('maps text + tool_use content and drops unknown block kinds', async () => {
    const { client } = makeClient(
      anthropicMessage({
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 'tu-9',
            name: 'fetch_url',
            input: { url: 'https://x' },
          },
          // An unsupported block kind the neutral model doesn't carry.
          { type: 'thinking', thinking: 'hmm', signature: 'sig' } as never,
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new AnthropicProvider(client).createMessage(BASE_PARAMS);

    expect(result.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tu-9', name: 'fetch_url', input: { url: 'https://x' } },
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it.each([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    [null, 'end'],
  ] as const)('maps stop_reason %s → %s', async (sdk, neutral) => {
    const { client } = makeClient(
      anthropicMessage({
        content: [{ type: 'text', text: 'x' }],
        stop_reason: sdk as Anthropic.Message['stop_reason'],
      }),
    );
    const result = await new AnthropicProvider(client).createMessage(BASE_PARAMS);
    expect(result.stopReason).toBe(neutral);
  });

  it('maps usage including cache tokens when the API returns them', async () => {
    const { client } = makeClient(
      anthropicMessage({
        content: [{ type: 'text', text: 'x' }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          // Fields absent from SDK 0.30.1's Usage type but read defensively.
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        } as unknown as Anthropic.Usage,
      }),
    );
    const result = await new AnthropicProvider(client).createMessage(BASE_PARAMS);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
    });
  });

  it('omits cache token fields when the API does not return them', async () => {
    const { client } = makeClient(
      anthropicMessage({
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 100, output_tokens: 40 },
      }),
    );
    const result = await new AnthropicProvider(client).createMessage(BASE_PARAMS);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
  });
});

describe('AnthropicProvider — error normalization', () => {
  it.each([
    [401, LlmAuthError],
    [403, LlmAuthError],
    [429, LlmRateLimitError],
    [529, LlmOverloadedError],
    [503, LlmOverloadedError],
    [500, LlmProviderError],
  ])('maps APIError status %i to the right neutral error', async (status, Err) => {
    const apiError = new Anthropic.APIError(
      status,
      undefined,
      `http ${status}`,
      undefined,
    );
    const create = vi.fn(async () => {
      throw apiError;
    });
    const { client } = makeClient(
      anthropicMessage({ content: [] }),
      create,
    );
    await expect(
      new AnthropicProvider(client).createMessage(BASE_PARAMS),
    ).rejects.toBeInstanceOf(Err);
  });

  it('wraps a non-API error as LlmProviderError', async () => {
    const create = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const { client } = makeClient(anthropicMessage({ content: [] }), create);
    const err = await new AnthropicProvider(client)
      .createMessage(BASE_PARAMS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).provider).toBe('anthropic');
    expect((err as LlmProviderError).message).toContain('socket hang up');
  });
});

describe('AnthropicProvider — misc', () => {
  it('declares capabilities (caching off on SDK 0.30.1)', () => {
    const { client } = makeClient(anthropicMessage({ content: [] }));
    const provider = new AnthropicProvider(client);
    expect(provider.name).toBe('anthropic');
    expect(provider.capabilities).toEqual({
      toolUse: true,
      parallelToolUse: true,
      caching: false,
    });
  });

  it('createAnthropicProvider throws on a missing/placeholder key', () => {
    expect(() => createAnthropicProvider('')).toThrow(
      'ANTHROPIC_API_KEY is not set',
    );
    expect(() => createAnthropicProvider('change-me-in-production')).toThrow(
      'ANTHROPIC_API_KEY is not set',
    );
  });

  it('createAnthropicProvider builds a provider for a real-looking key', () => {
    const provider = createAnthropicProvider('sk-ant-test');
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});
