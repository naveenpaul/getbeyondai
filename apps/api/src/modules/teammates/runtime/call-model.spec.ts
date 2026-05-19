import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  callModel,
  type AnthropicMessagesClient,
} from './call-model';
import { BudgetExceededError } from './cost';

/**
 * Unit tests against a fake Anthropic client + in-memory Prisma. Real DB +
 * full audit-log persistence is covered in the integration spec attached to
 * runAgent / the Researcher (T4b/T4c).
 */

interface FakeRun {
  id: string;
  orgId: string;
  costCents: number;
  lastBeatAt: Date;
}

interface FakeModelCall {
  id: string;
  runId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  at: Date;
}

function makeFakePrisma(seed: FakeRun) {
  const runs = new Map<string, FakeRun>([[seed.id, { ...seed }]]);
  const modelCalls: FakeModelCall[] = [];
  let mcIdCounter = 0;
  return {
    agentRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const existing = runs.get(where.id);
        return existing ? { ...existing } : null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { costCents?: { increment: number }; lastBeatAt?: Date };
        }) => {
          const existing = runs.get(where.id);
          if (!existing) throw new Error('not found');
          if (data.costCents?.increment !== undefined) {
            existing.costCents += data.costCents.increment;
          }
          if (data.lastBeatAt) existing.lastBeatAt = data.lastBeatAt;
          return { ...existing };
        },
      ),
    },
    modelCall: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<FakeModelCall, 'id' | 'at'>;
        }) => {
          const row: FakeModelCall = {
            id: `mc-${++mcIdCounter}`,
            at: new Date(),
            ...data,
          };
          modelCalls.push(row);
          return row;
        },
      ),
    },
    _runs: runs,
    _modelCalls: modelCalls,
  };
}

function fakeMessage(
  inputTokens: number,
  outputTokens: number,
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'response text' }],
    model: 'claude-sonnet-4-6',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

function makeFakeAnthropic(message: Anthropic.Message): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn(async () => message),
    } as unknown as Anthropic['messages'],
  };
}

const BASE_RUN: FakeRun = {
  id: 'run-1',
  orgId: 'org-A',
  costCents: 0,
  lastBeatAt: new Date('2026-05-19T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('callModel — happy path', () => {
  it('returns the message + persists a ModelCall + bumps AgentRun.costCents', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const anthropic = makeFakeAnthropic(fakeMessage(1000, 500));

    const result = await callModel(prisma as never, anthropic, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 'You are a researcher.',
      messages: [{ role: 'user', content: 'Tell me about Acme.' }],
      budgetCents: 100,
    });

    // sonnet: 1000 input @ $3/M + 500 output @ $15/M
    //   = 0.003 + 0.0075 = 0.0105 USD = 1.05 cents → ceil 2 cents.
    expect(result.costCents).toBe(2);
    expect(result.message.content[0]).toMatchObject({ type: 'text' });
    expect(prisma._modelCalls).toHaveLength(1);
    expect(prisma._modelCalls[0]).toMatchObject({
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      costCents: 2,
    });
    expect(prisma._runs.get('run-1')?.costCents).toBe(2);
    expect(result.modelCallId).toBe('mc-1');
  });

  it('bumps AgentRun.lastBeatAt on every call (heartbeat for reaper)', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const anthropic = makeFakeAnthropic(fakeMessage(100, 50));

    await callModel(prisma as never, anthropic, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'x' }],
      budgetCents: 100,
    });

    const after = prisma._runs.get('run-1')?.lastBeatAt;
    expect(after?.getTime()).toBeGreaterThan(BASE_RUN.lastBeatAt.getTime());
  });

  it('accumulates costCents across multiple calls', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const anthropic = makeFakeAnthropic(fakeMessage(1000, 500));

    await callModel(prisma as never, anthropic, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'a' }],
      budgetCents: 100,
    });
    await callModel(prisma as never, anthropic, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'b' }],
      budgetCents: 100,
    });

    expect(prisma._runs.get('run-1')?.costCents).toBe(4); // 2 + 2
    expect(prisma._modelCalls).toHaveLength(2);
  });

  it('forwards system prompt, messages, tools, max_tokens, tool_choice to SDK', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const message = fakeMessage(10, 10);
    const create = vi.fn(async () => message);
    const anthropic: AnthropicMessagesClient = {
      messages: { create } as unknown as Anthropic['messages'],
    };
    const tools: Anthropic.Tool[] = [
      {
        name: 'brave_search',
        description: 'web search',
        input_schema: { type: 'object', properties: {} },
      },
    ];
    await callModel(prisma as never, anthropic, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools,
      maxTokens: 2048,
      toolChoice: { type: 'tool', name: 'brave_search' },
      budgetCents: 100,
    });

    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools,
      max_tokens: 2048,
      tool_choice: { type: 'tool', name: 'brave_search' },
    });
  });

  it('defaults max_tokens to 4096 when not provided', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const create = vi.fn(async () => fakeMessage(10, 10));
    const anthropic: AnthropicMessagesClient = {
      messages: { create } as unknown as Anthropic['messages'],
    };
    await callModel(prisma as never, anthropic, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'x' }],
      budgetCents: 100,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    );
  });
});

describe('callModel — preflight + budget enforcement', () => {
  it('throws when AgentRun does not exist (no SDK call made)', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const create = vi.fn();
    const anthropic: AnthropicMessagesClient = {
      messages: { create } as unknown as Anthropic['messages'],
    };

    await expect(
      callModel(prisma as never, anthropic, {
        runId: 'does-not-exist',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'x' }],
        budgetCents: 100,
      }),
    ).rejects.toThrow('AgentRun does-not-exist not found');
    expect(create).not.toHaveBeenCalled();
  });

  it('pre-check: throws when run.costCents already at or over budget', async () => {
    const prisma = makeFakePrisma({ ...BASE_RUN, costCents: 100 });
    const create = vi.fn(async () => fakeMessage(10, 10));
    const anthropic: AnthropicMessagesClient = {
      messages: { create } as unknown as Anthropic['messages'],
    };

    await expect(
      callModel(prisma as never, anthropic, {
        runId: 'run-1',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'x' }],
        budgetCents: 50,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // Did NOT consume an SDK call.
    expect(create).not.toHaveBeenCalled();
  });

  it('post-check: throws when this call pushes over, BUT persists ModelCall first', async () => {
    const prisma = makeFakePrisma({ ...BASE_RUN, costCents: 0 });
    // 1M input + 1M output at sonnet = 1800 cents
    const anthropic = makeFakeAnthropic(fakeMessage(1_000_000, 1_000_000));

    await expect(
      callModel(prisma as never, anthropic, {
        runId: 'run-1',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'x' }],
        budgetCents: 100,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    // ModelCall persisted (audit trail) + AgentRun bumped (so the user sees
    // the cost of the call that broke the budget).
    expect(prisma._modelCalls).toHaveLength(1);
    expect(prisma._modelCalls[0]?.costCents).toBe(1800);
    expect(prisma._runs.get('run-1')?.costCents).toBe(1800);
  });

  it('post-check passes when current + new cost exactly equals budget', async () => {
    const prisma = makeFakePrisma({ ...BASE_RUN, costCents: 98 });
    // Cost 2¢ → 98 + 2 = 100 = budget.
    const anthropic = makeFakeAnthropic(fakeMessage(1000, 500));

    await expect(
      callModel(prisma as never, anthropic, {
        runId: 'run-1',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'x' }],
        budgetCents: 100,
      }),
    ).resolves.toMatchObject({ costCents: 2 });
  });
});
