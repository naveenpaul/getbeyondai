import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callModel } from './call-model';
import { BudgetExceededError } from './cost';
import type { LlmProvider } from './llm-provider';
import type { CreateMessageResult, StopReason } from './llm-types';

/**
 * Unit tests against a fake LlmProvider + in-memory Prisma. callModel is the
 * policy layer (budget + audit); the vendor wire mapping is the provider's
 * job and is covered by providers/anthropic.provider.spec.ts. Real DB + full
 * audit-log persistence is covered in the integration specs.
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
        async ({ data }: { data: Omit<FakeModelCall, 'id' | 'at'> }) => {
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

/** A neutral provider response. */
function fakeResult(
  inputTokens: number,
  outputTokens: number,
  stopReason: StopReason = 'end',
): CreateMessageResult {
  return {
    content: [{ type: 'text', text: 'response text' }],
    stopReason,
    usage: { inputTokens, outputTokens },
    model: 'claude-sonnet-4-6',
  };
}

/** A fake LlmProvider whose createMessage returns a fixed neutral result. */
function makeFakeProvider(
  result: CreateMessageResult,
  create = vi.fn(async () => result),
): LlmProvider & { createMessage: typeof create } {
  return {
    name: 'fake',
    capabilities: { toolUse: true, parallelToolUse: true, caching: false },
    createMessage: create,
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
    const provider = makeFakeProvider(fakeResult(1000, 500));

    const result = await callModel(prisma as never, provider, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 'You are a researcher.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Tell me about Acme.' }] },
      ],
      budgetCents: 100,
    });

    // sonnet: 1000 input @ $3/M + 500 output @ $15/M
    //   = 0.003 + 0.0075 = 0.0105 USD = 1.05 cents → rounds to 1 cent.
    expect(result.costCents).toBe(1);
    expect(result.message.content[0]).toMatchObject({ type: 'text' });
    expect(prisma._modelCalls).toHaveLength(1);
    expect(prisma._modelCalls[0]).toMatchObject({
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      costCents: 1,
    });
    expect(prisma._runs.get('run-1')?.costCents).toBe(1);
    expect(result.modelCallId).toBe('mc-1');
  });

  it('bumps AgentRun.lastBeatAt on every call (heartbeat for reaper)', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const provider = makeFakeProvider(fakeResult(100, 50));

    await callModel(prisma as never, provider, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      budgetCents: 100,
    });

    const after = prisma._runs.get('run-1')?.lastBeatAt;
    expect(after?.getTime()).toBeGreaterThan(BASE_RUN.lastBeatAt.getTime());
  });

  it('accumulates costCents across multiple calls', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const provider = makeFakeProvider(fakeResult(1000, 500));

    await callModel(prisma as never, provider, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
      budgetCents: 100,
    });
    await callModel(prisma as never, provider, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'b' }] }],
      budgetCents: 100,
    });

    expect(prisma._runs.get('run-1')?.costCents).toBe(2); // 1 + 1
    expect(prisma._modelCalls).toHaveLength(2);
  });

  it('forwards neutral params (model, prompt, messages, tools, maxTokens, toolChoice) to the provider', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const create = vi.fn(async () => fakeResult(10, 10));
    const provider = makeFakeProvider(fakeResult(10, 10), create);
    const tools = [
      {
        name: 'brave_search',
        description: 'web search',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    await callModel(prisma as never, provider, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools,
      maxTokens: 2048,
      toolChoice: { type: 'tool', name: 'brave_search' },
      budgetCents: 100,
    });

    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools,
      maxTokens: 2048,
      toolChoice: { type: 'tool', name: 'brave_search' },
    });
  });

  it('forwards undefined maxTokens (provider applies its own default)', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const create = vi.fn(async () => fakeResult(10, 10));
    const provider = makeFakeProvider(fakeResult(10, 10), create);
    await callModel(prisma as never, provider, {
      runId: 'run-1',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      budgetCents: 100,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: undefined }),
    );
  });
});

describe('callModel — preflight + budget enforcement', () => {
  it('throws when AgentRun does not exist (no provider call made)', async () => {
    const prisma = makeFakePrisma(BASE_RUN);
    const create = vi.fn(async () => fakeResult(10, 10));
    const provider = makeFakeProvider(fakeResult(10, 10), create);

    await expect(
      callModel(prisma as never, provider, {
        runId: 'does-not-exist',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        budgetCents: 100,
      }),
    ).rejects.toThrow('AgentRun does-not-exist not found');
    expect(create).not.toHaveBeenCalled();
  });

  it('pre-check: throws when run.costCents already at or over budget', async () => {
    const prisma = makeFakePrisma({ ...BASE_RUN, costCents: 100 });
    const create = vi.fn(async () => fakeResult(10, 10));
    const provider = makeFakeProvider(fakeResult(10, 10), create);

    await expect(
      callModel(prisma as never, provider, {
        runId: 'run-1',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        budgetCents: 50,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // Did NOT consume a provider call.
    expect(create).not.toHaveBeenCalled();
  });

  it('post-check: throws when this call pushes over, BUT persists ModelCall first', async () => {
    const prisma = makeFakePrisma({ ...BASE_RUN, costCents: 0 });
    // 1M input + 1M output at sonnet = 1800 cents
    const provider = makeFakeProvider(fakeResult(1_000_000, 1_000_000));

    await expect(
      callModel(prisma as never, provider, {
        runId: 'run-1',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
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
    // 1000 in @ $3/M + 1000 out @ $15/M = 0.3 + 1.5 = 1.8¢ → rounds to 2¢.
    // 98 + 2 = 100 = budget (post-check passes at exact equality).
    const provider = makeFakeProvider(fakeResult(1000, 1000));

    await expect(
      callModel(prisma as never, provider, {
        runId: 'run-1',
        modelName: 'claude-sonnet-4-6',
        systemPrompt: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        budgetCents: 100,
      }),
    ).resolves.toMatchObject({ costCents: 2 });
  });
});
