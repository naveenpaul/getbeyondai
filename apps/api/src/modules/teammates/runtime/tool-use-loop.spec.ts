import { describe, expect, it, vi } from 'vitest';
import { runAgent } from './tool-use-loop';
import type { AgentTool } from './agent-tool';
import type { LlmProvider } from './llm-provider';
import type {
  ContentBlock,
  CreateMessageResult,
  StopReason,
} from './llm-types';
import type { RunEvent } from './run-event-bus';

/**
 * Unit tests against a fake Anthropic client + in-memory Prisma. The
 * runtime → real-DB persistence is covered by the integration spec when
 * the Researcher controller lands (T4c).
 */

interface FakeRun {
  id: string;
  orgId: string;
  status: 'running' | 'completed' | 'abstained' | 'failed';
  reason: string | null;
  outputDraftId: string | null;
  costCents: number;
  lastBeatAt: Date;
  completedAt: Date | null;
}
interface FakeModelCall { id: string; runId: string; costCents: number }
interface FakeToolCall { id: string; runId: string; toolSeq: number; toolName: string; args: unknown; result: unknown; durationMs: number; costCents: number; modelCallId: string }
interface FakeCitation { id: string; runId: string; url: string }
interface FakeDraft { id: string; orgId: string; teammate: string; runId: string; type: string; content: unknown; status: string }
interface FakeClaim { id: string; draftId: string; text: string; citationId: string | null; abstained: boolean }

function makeFakePrisma(seedRun: FakeRun, seedCitations: FakeCitation[] = []) {
  const runs = new Map<string, FakeRun>([[seedRun.id, { ...seedRun }]]);
  const modelCalls: FakeModelCall[] = [];
  const toolCalls: FakeToolCall[] = [];
  const citations = new Map<string, FakeCitation>(
    seedCitations.map((c) => [c.id, { ...c }]),
  );
  const drafts: FakeDraft[] = [];
  const claims: FakeClaim[] = [];
  let mcCounter = 0;
  let tcCounter = 0;
  let draftCounter = 0;
  let claimCounter = 0;
  return {
    agentRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = runs.get(where.id);
        return r ? { ...r } : null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Omit<FakeRun, 'costCents'>> & {
            costCents?: { increment: number };
          };
        }) => {
          const r = runs.get(where.id);
          if (!r) throw new Error('not found');
          if (
            data.costCents !== undefined &&
            typeof data.costCents === 'object'
          ) {
            r.costCents += data.costCents.increment;
          }
          if (data.status) r.status = data.status as FakeRun['status'];
          if (data.reason !== undefined) r.reason = data.reason;
          if (data.outputDraftId !== undefined)
            r.outputDraftId = data.outputDraftId;
          if (data.lastBeatAt) r.lastBeatAt = data.lastBeatAt;
          if (data.completedAt !== undefined) r.completedAt = data.completedAt;
          return { ...r };
        },
      ),
    },
    modelCall: {
      create: vi.fn(async ({ data }: { data: { runId: string; costCents: number } }) => {
        const row: FakeModelCall = {
          id: `mc-${++mcCounter}`,
          runId: data.runId,
          costCents: data.costCents,
        };
        modelCalls.push(row);
        return row;
      }),
    },
    toolCall: {
      create: vi.fn(async ({ data }: { data: Omit<FakeToolCall, 'id'> }) => {
        const row: FakeToolCall = { id: `tc-${++tcCounter}`, ...data };
        toolCalls.push(row);
        return row;
      }),
    },
    citation: {
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) => {
        return [...citations.values()].filter((c) => c.runId === where.runId);
      }),
    },
    draft: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<FakeDraft, 'id'> & {
            claims?: { create: Array<Omit<FakeClaim, 'id' | 'draftId'>> };
          };
        }) => {
          const id = `draft-${++draftCounter}`;
          drafts.push({
            id,
            orgId: data.orgId,
            teammate: data.teammate,
            runId: data.runId,
            type: data.type,
            content: data.content,
            status: data.status,
          });
          if (data.claims?.create) {
            for (const c of data.claims.create) {
              claims.push({
                id: `claim-${++claimCounter}`,
                draftId: id,
                text: c.text,
                citationId: c.citationId ?? null,
                abstained: c.abstained,
              });
            }
          }
          return { id, ...data };
        },
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        agentRun: { update: async () => {} },
        draft: { create: async (args: unknown) => fakePrisma.draft.create(args as never) },
      }),
    ),
    _runs: runs,
    _modelCalls: modelCalls,
    _toolCalls: toolCalls,
    _drafts: drafts,
    _claims: claims,
  };
}

// Hoist for $transaction self-reference
let fakePrisma: ReturnType<typeof makeFakePrisma>;

function setup(seedRun: FakeRun, seedCitations: FakeCitation[] = []) {
  fakePrisma = makeFakePrisma(seedRun, seedCitations);
  return fakePrisma;
}

// Now fix the $transaction body to delegate to the proper instance.
function makeProperFakePrisma(seedRun: FakeRun, seedCitations: FakeCitation[] = []) {
  const inst = makeFakePrisma(seedRun, seedCitations);
  inst.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(inst),
  ) as never;
  return inst;
}

/** A neutral provider response (replaces the old Anthropic.Message fake). */
function fakeMessage(opts: {
  content: ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: StopReason;
}): CreateMessageResult {
  return {
    content: opts.content,
    stopReason: opts.stopReason ?? 'tool_use',
    usage: {
      inputTokens: opts.inputTokens ?? 100,
      outputTokens: opts.outputTokens ?? 50,
    },
    model: 'claude-sonnet-4-6',
  };
}

function toolUseBlock(
  name: string,
  input: unknown,
  id = `tu-${Math.random()}`,
): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

const BASE_RUN: FakeRun = {
  id: 'run-1',
  orgId: 'org-A',
  status: 'running',
  reason: null,
  outputDraftId: null,
  costCents: 0,
  lastBeatAt: new Date(),
  completedAt: null,
};

const FAKE_CAPS = {
  toolUse: true,
  parallelToolUse: true,
  caching: false,
} as const;

/** Fake provider that returns `results` one per call, in order. */
function makeProvider(results: CreateMessageResult[]): LlmProvider {
  const createMessage = vi.fn();
  for (const r of results) createMessage.mockResolvedValueOnce(r);
  return { name: 'fake', capabilities: FAKE_CAPS, createMessage };
}

/** Fake provider backed by a custom createMessage (for throw/clock cases). */
function makeProviderFn(
  createMessage: LlmProvider['createMessage'],
): LlmProvider {
  return { name: 'fake', capabilities: FAKE_CAPS, createMessage };
}

// ─── tests ──────────────────────────────────────────────────────────

describe('runAgent — happy path (single emit_draft turn)', () => {
  it('persists Draft + Claims + marks run completed when model calls emit_draft with a cited claim', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'https://example.com' },
    ]);
    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: { headline: 'Acme', summary: 'A startup' },
            claims: [{ text: 'Founded in 2022', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 'You are a researcher.',
      userPrompt: 'Tell me about Acme.',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('completed');
    expect(result.draftId).toBeTruthy();
    expect(result.toolCallCount).toBe(1);
    expect(prisma._drafts).toHaveLength(1);
    expect(prisma._claims).toHaveLength(1);
    expect(prisma._claims[0]).toMatchObject({
      text: 'Founded in 2022',
      citationId: 'cit-1',
    });
    expect(prisma._runs.get('run-1')?.status).toBe('completed');
    expect(prisma._runs.get('run-1')?.outputDraftId).toBe(result.draftId);
  });
});

describe('runAgent — multi-turn with tool calls', () => {
  it('dispatches tools, persists ToolCall rows, feeds results back, then emits', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'https://example.com' },
    ]);
    const searchExec = vi.fn(async () => ({ results: ['Acme is a SaaS startup'] }));
    const tools: AgentTool[] = [
      {
        name: 'brave_search',
        description: 'web search',
        inputSchema: { type: 'object' },
        execute: searchExec,
      },
    ];
    const llm = makeProvider([
      fakeMessage({
        content: [toolUseBlock('brave_search', { q: 'Acme funding' }, 'tu-1')],
      }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: { headline: 'Acme' },
            claims: [{ text: 'SaaS startup', citationId: 'cit-1' }],
          }),
        ],
        stopReason: 'tool_use',
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('completed');
    expect(result.toolCallCount).toBe(2);
    expect(searchExec).toHaveBeenCalledWith(
      { q: 'Acme funding' },
      expect.objectContaining({ runId: 'run-1', orgId: 'org-A' }),
    );
    // Two tool calls persisted (brave_search + emit_draft)
    expect(prisma._toolCalls).toHaveLength(2);
    expect(prisma._toolCalls[0]?.toolName).toBe('brave_search');
    expect(prisma._toolCalls[1]?.toolName).toBe('emit_draft');
    // toolSeq monotonic
    expect(prisma._toolCalls[0]?.toolSeq).toBe(1);
    expect(prisma._toolCalls[1]?.toolSeq).toBe(2);
  });

  it('unknown tool name → tool_result with is_error, no abort', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    const llm = makeProvider([
      fakeMessage({
        content: [toolUseBlock('nonexistent_tool', {}, 'tu-1')],
      }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('completed');
    expect(prisma._toolCalls[0]?.toolName).toBe('nonexistent_tool');
    expect(prisma._toolCalls[0]?.result).toMatchObject({ error: 'unknown_tool' });
  });

  it('tool execute() error → tool_result with is_error, loop continues', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    const tools: AgentTool[] = [
      {
        name: 'flaky_tool',
        description: 'fails',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => {
          throw new Error('tool blew up');
        }),
      },
    ];
    const llm = makeProvider([
      fakeMessage({ content: [toolUseBlock('flaky_tool', {}, 'tu-1')] }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('completed');
    // First ToolCall row records the error result.
    expect(prisma._toolCalls[0]?.result).toMatchObject({
      error: 'tool blew up',
    });
  });
});

describe('runAgent — bound enforcement', () => {
  it('maxToolCalls trips → status=abstained reason=exceeded_maxToolCalls', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN);
    // Model keeps trying to call a tool forever.
    const llm = makeProviderFn(
      vi.fn(async () =>
        fakeMessage({
          content: [toolUseBlock('any_tool', {}, `tu-${Math.random()}`)],
        }),
      ),
    );

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 10000,
      maxToolCalls: 3,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('exceeded_maxToolCalls');
    expect(prisma._runs.get('run-1')?.reason).toBe('exceeded_maxToolCalls');
  });

  it('maxWallSecs trips → status=abstained reason=exceeded_maxWallSecs', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN);
    let clock = 1_000_000;
    const llm = makeProviderFn(
      vi.fn(async () => {
        // Advance the clock past maxWallSecs after the first call.
        clock += 100_000; // 100 seconds
        return fakeMessage({
          content: [toolUseBlock('any', {}, `tu-${clock}`)],
        });
      }),
    );

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 10000,
      maxToolCalls: 100,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
      now: () => clock,
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('exceeded_maxWallSecs');
  });

  it('budget overrun mid-loop → status=abstained reason=exceeded_budget', async () => {
    const prisma = makeProperFakePrisma({ ...BASE_RUN, costCents: 0 });
    // Each call costs ~1800¢. budget=1500¢ → second call trips.
    const llm = makeProviderFn(
      vi.fn(async () =>
        fakeMessage({
          content: [toolUseBlock('any', {}, `tu-${Math.random()}`)],
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ),
    );

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 1500,
      maxToolCalls: 100,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('exceeded_budget');
  });
});

describe('runAgent — claim enforcement', () => {
  it('emit_draft with malformed args → reported back; model retries with valid args → completed', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    const llm = makeProvider([
      // First turn: malformed (claims missing text)
      fakeMessage({
        content: [
          toolUseBlock(
            'emit_draft',
            { type: 'research_brief', content: {}, claims: [{}] },
            'tu-1',
          ),
        ],
      }),
      // Second turn: valid retry
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: { headline: 'x' },
            claims: [{ text: 'fact', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('completed');
    expect(prisma._toolCalls[0]?.result).toMatchObject({
      error: 'zod_validation_failed',
    });
  });

  it('emit_draft with only uncited+not-abstained claims → all dropped → retry message sent', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, []);
    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 'unsourced fact', citationId: null }],
          }),
        ],
      }),
      // Model never recovers — abstains by exceeding tool calls
      fakeMessage({
        content: [toolUseBlock('any_tool', {}, 'tu-x')],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 2,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('exceeded_maxToolCalls');
    // No Draft was persisted
    expect(prisma._drafts).toHaveLength(0);
    // First emit_draft attempt recorded as failed
    expect(prisma._toolCalls[0]?.result).toMatchObject({
      error: 'no_valid_claims',
    });
  });

  it('emit_draft citing a fake citationId → claim dropped; if dangling-only, retry message sent', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, []);
    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 'fact', citationId: 'cit-fake' }],
          }),
        ],
      }),
      // exhaust tool calls
      fakeMessage({
        content: [toolUseBlock('any', {}, 'x')],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 2,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });
    expect(result.status).toBe('abstained');
    expect(prisma._drafts).toHaveLength(0);
  });
});

describe('runAgent — parallel tool dispatch within a turn', () => {
  it('dispatches multiple tool_use blocks concurrently (Promise.all, not serial)', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);

    // Each tool sleeps for the same delay. Serial would take 3*delay; parallel
    // takes ~1*delay. We test the START times to confirm overlap.
    const startTimes: number[] = [];
    const TOOL_DELAY_MS = 30;
    const slowTool = (name: string): AgentTool => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      execute: vi.fn(async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, TOOL_DELAY_MS));
        return { ok: true };
      }),
    });
    const tools: AgentTool[] = [slowTool('a'), slowTool('b'), slowTool('c')];

    const llm = makeProvider([
      // First turn: model emits THREE independent tool_use blocks
      fakeMessage({
        content: [
          toolUseBlock('a', {}, 'tu-a'),
          toolUseBlock('b', {}, 'tu-b'),
          toolUseBlock('c', {}, 'tu-c'),
        ],
      }),
      // Second turn: emit_draft
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: { headline: 'x' },
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    const wallStart = Date.now();
    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });
    const wallTotal = Date.now() - wallStart;

    expect(result.status).toBe('completed');

    // All three tools started within ~10ms of each other (concurrent),
    // NOT spaced by TOOL_DELAY_MS each (which would mean serial dispatch).
    expect(startTimes).toHaveLength(3);
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(TOOL_DELAY_MS);

    // Whole run should be well under the serial floor (3 * TOOL_DELAY_MS).
    // Pad for fake-message overhead. If this fails we regressed to serial.
    expect(wallTotal).toBeLessThan(3 * TOOL_DELAY_MS);
  });

  it('assigns toolSeq in array order (deterministic, race-free)', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    // Tools resolve in REVERSE order (last is fastest) to prove toolSeq
    // tracks the array index, not completion order.
    const tools: AgentTool[] = ['a', 'b', 'c'].map((name, i) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      execute: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30 - i * 10));
        return { name };
      }),
    }));

    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('a', {}, 'tu-a'),
          toolUseBlock('b', {}, 'tu-b'),
          toolUseBlock('c', {}, 'tu-c'),
        ],
      }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });

    // ToolCalls ordered by toolSeq must match the tool_use array order,
    // even though c finished first, b second, a last.
    const calls = prisma._toolCalls
      .filter((tc) => tc.toolName !== 'emit_draft')
      .sort((x, y) => x.toolSeq - y.toolSeq);
    expect(calls.map((c) => c.toolName)).toEqual(['a', 'b', 'c']);
    // toolSeq monotonic + dense (1, 2, 3) for the first turn.
    expect(calls.map((c) => c.toolSeq)).toEqual([1, 2, 3]);
  });

  it('parallel batch with one tool failing: others still complete + run continues', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    const tools: AgentTool[] = [
      {
        name: 'good_a',
        description: '',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => ({ ok: true })),
      },
      {
        name: 'flaky',
        description: '',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      {
        name: 'good_b',
        description: '',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => ({ ok: true })),
      },
    ];
    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('good_a', {}, 'tu-1'),
          toolUseBlock('flaky', {}, 'tu-2'),
          toolUseBlock('good_b', {}, 'tu-3'),
        ],
      }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });
    expect(result.status).toBe('completed');

    // All three ToolCall rows persisted (good ones with ok, flaky with the error)
    const turn1 = prisma._toolCalls.filter((tc) =>
      ['good_a', 'flaky', 'good_b'].includes(tc.toolName),
    );
    expect(turn1).toHaveLength(3);
    const flaky = turn1.find((tc) => tc.toolName === 'flaky');
    expect(flaky?.result).toMatchObject({ error: 'boom' });
  });
});

describe('runAgent — emitEvent progress callback', () => {
  it('happy path: emits model→tool→draft→completed events in order', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    const events: RunEvent[] = [];
    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('any_tool', {}, 'tu-1'),
        ],
      }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);
    const tools: AgentTool[] = [
      {
        name: 'any_tool',
        description: '',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => ({ ok: true })),
      },
    ];

    await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
      emitEvent: (e) => events.push(e),
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'model_call_started',
      'model_call_completed',
      'tool_call_started', // any_tool
      'tool_call_completed',
      'model_call_started',
      'model_call_completed',
      'tool_call_started', // emit_draft
      'draft_emitted',
      'tool_call_completed',
      'run_completed',
    ]);
    // Every event carries the runId.
    for (const e of events) expect(e.runId).toBe('run-1');
  });

  it('abstained path: emits run_abstained with the trip reason', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN);
    const events: RunEvent[] = [];
    const llm = makeProvider([
      fakeMessage({
        content: [
          { type: 'text', text: 'no draft' },
        ],
        stopReason: 'end',
      }),
    ]);

    await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
      emitEvent: (e) => events.push(e),
    });

    const last = events.at(-1);
    expect(last?.type).toBe('run_abstained');
    if (last?.type === 'run_abstained') {
      expect(last.data.reason).toBe('no_draft_emitted');
    }
  });

  it('tool_call_completed includes a summary for brave_search + fetch_url', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN, [
      { id: 'cit-1', runId: 'run-1', url: 'x' },
    ]);
    const events: RunEvent[] = [];
    const tools: AgentTool[] = [
      {
        name: 'brave_search',
        description: '',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => ({ results: [{ url: 'u1' }, { url: 'u2' }] })),
      },
      {
        name: 'fetch_url',
        description: '',
        inputSchema: { type: 'object' },
        execute: vi.fn(async () => ({
          url: 'https://acme.example',
          citationId: 'cit-1',
        })),
      },
    ];
    const llm = makeProvider([
      fakeMessage({
        content: [
          toolUseBlock('brave_search', { q: 'x' }, 'tu-1'),
          toolUseBlock('fetch_url', { url: 'https://acme.example' }, 'tu-2'),
        ],
      }),
      fakeMessage({
        content: [
          toolUseBlock('emit_draft', {
            type: 'research_brief',
            content: {},
            claims: [{ text: 't', citationId: 'cit-1' }],
          }),
        ],
      }),
    ]);

    await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools,
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
      emitEvent: (e) => events.push(e),
    });

    const completions = events.filter(
      (e) => e.type === 'tool_call_completed',
    );
    const search = completions.find(
      (e) => e.type === 'tool_call_completed' && e.data.toolName === 'brave_search',
    );
    const fetch = completions.find(
      (e) => e.type === 'tool_call_completed' && e.data.toolName === 'fetch_url',
    );
    if (search?.type === 'tool_call_completed') {
      expect(search.data.summary).toBe('2 results');
    } else expect.fail('no brave_search completion');
    if (fetch?.type === 'tool_call_completed') {
      expect(fetch.data.summary).toContain('https://acme.example');
    } else expect.fail('no fetch_url completion');
  });
});

describe('runAgent — no draft after turn ends', () => {
  it('model produces text-only response (end_turn) → status=abstained reason=no_draft_emitted', async () => {
    const prisma = makeProperFakePrisma(BASE_RUN);
    const llm = makeProvider([
      fakeMessage({
        content: [{ type: 'text', text: 'I cannot find any info.' }],
        stopReason: 'end',
      }),
    ]);

    const result = await runAgent({
      runId: 'run-1',
      orgId: 'org-A',
      teammate: 'researcher',
      modelName: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userPrompt: 'u',
      tools: [],
      budgetCents: 100,
      maxToolCalls: 10,
      maxWallSecs: 60,
      prisma: prisma as never,
      llm,
    });
    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('no_draft_emitted');
  });
});
