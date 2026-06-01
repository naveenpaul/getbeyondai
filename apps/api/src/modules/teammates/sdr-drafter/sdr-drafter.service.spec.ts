import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for runSdrDrafter — covers the small set of branches the
 * integration suite can't conveniently reach without exotic fixtures:
 *
 *   1. recipientEmail fallback when contact.normalizedEmail is null
 *   2. recipientName fallback to null when both firstName + lastName are absent
 *   3. deps.tools override (custom tool set)
 *   4. Every `input.X ?? DEFAULTS.X` default branch
 *
 * The integration spec always creates contacts with first/last names + an
 * email + lets the controller default modelName/budgets, so those branches
 * stay uncovered there. Mocking runAgent here lets us assert exactly which
 * options were forwarded.
 */

const runAgentMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    status: 'completed',
    reason: undefined,
    draftId: 'draft-1',
    costCents: 12,
    toolCallCount: 3,
  }),
);

vi.mock('../runtime/tool-use-loop', () => ({
  runAgent: runAgentMock,
}));

import { runSdrDrafter } from './sdr-drafter.service';
import type { LlmProvider } from '../runtime/llm-provider';
import type { AgentTool } from '../runtime/agent-tool';

type ContactFixture = {
  id: string;
  orgId: string;
  normalizedEmail: string | null;
  firstName: string | null;
  lastName: string | null;
};

function makeDeps(contact: ContactFixture) {
  const findFirstOrThrow = vi.fn().mockResolvedValue(contact);
  const prisma = {
    contact: { findFirstOrThrow },
  } as unknown as Parameters<typeof runSdrDrafter>[0]['prisma'];
  const llm = {} as LlmProvider;
  return { prisma, llm, findFirstOrThrow };
}

describe('runSdrDrafter', () => {
  beforeEach(() => {
    runAgentMock.mockClear();
  });

  it('falls back to empty string when contact.normalizedEmail is null', async () => {
    const deps = makeDeps({
      id: 'c1',
      orgId: 'o1',
      normalizedEmail: null,
      firstName: 'Sarah',
      lastName: 'Patel',
    });

    await runSdrDrafter(deps, {
      orgId: 'o1',
      triggeredBy: 'u1',
      contactId: 'c1',
      runId: 'run-1',
    });

    const opts = runAgentMock.mock.calls[0]?.[0] as {
      draftRecipient: { email: string; name: string | null };
    };
    expect(opts.draftRecipient.email).toBe('');
    expect(opts.draftRecipient.name).toBe('Sarah Patel');
  });

  it('falls back to null recipientName when both firstName and lastName are absent', async () => {
    const deps = makeDeps({
      id: 'c1',
      orgId: 'o1',
      normalizedEmail: 'nameless@test.com',
      firstName: null,
      lastName: null,
    });

    await runSdrDrafter(deps, {
      orgId: 'o1',
      triggeredBy: 'u1',
      contactId: 'c1',
      runId: 'run-1',
    });

    const opts = runAgentMock.mock.calls[0]?.[0] as {
      draftRecipient: { email: string; name: string | null };
    };
    expect(opts.draftRecipient.name).toBeNull();
    expect(opts.draftRecipient.email).toBe('nameless@test.com');
  });

  it('joins firstName alone (no trailing whitespace) when lastName is absent', async () => {
    const deps = makeDeps({
      id: 'c1',
      orgId: 'o1',
      normalizedEmail: 'first-only@test.com',
      firstName: 'Sarah',
      lastName: null,
    });

    await runSdrDrafter(deps, {
      orgId: 'o1',
      triggeredBy: 'u1',
      contactId: 'c1',
      runId: 'run-1',
    });

    const opts = runAgentMock.mock.calls[0]?.[0] as {
      draftRecipient: { name: string | null };
    };
    expect(opts.draftRecipient.name).toBe('Sarah');
  });

  it('uses all defaults when input omits modelName / budgets / tool-set', async () => {
    const deps = makeDeps({
      id: 'c1',
      orgId: 'o1',
      normalizedEmail: 'x@test.com',
      firstName: 'X',
      lastName: 'Y',
    });

    await runSdrDrafter(deps, {
      orgId: 'o1',
      triggeredBy: 'u1',
      contactId: 'c1',
      runId: 'run-1',
    });

    const opts = runAgentMock.mock.calls[0]?.[0] as {
      modelName: string;
      budgetCents: number;
      maxToolCalls: number;
      maxWallSecs: number;
      tools: AgentTool[];
    };
    expect(opts.modelName).toBe('claude-sonnet-4-6');
    expect(opts.budgetCents).toBe(50);
    expect(opts.maxToolCalls).toBe(15);
    expect(opts.maxWallSecs).toBe(120);
    // Default tool set: get_contact, get_research_brief, brave_search, fetch_url
    expect(opts.tools.map((t) => t.name).sort()).toEqual([
      'brave_search',
      'fetch_url',
      'get_contact',
      'get_research_brief',
    ]);
  });

  it('forwards explicit overrides for modelName / budgets / tools / briefDraftId / goal', async () => {
    const deps = makeDeps({
      id: 'c1',
      orgId: 'o1',
      normalizedEmail: 'x@test.com',
      firstName: 'X',
      lastName: 'Y',
    });

    const customTool: AgentTool = {
      name: 'custom',
      description: 'd',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: vi.fn(),
    };

    await runSdrDrafter(
      { ...deps, tools: [customTool] },
      {
        orgId: 'o1',
        triggeredBy: 'u1',
        contactId: 'c1',
        runId: 'run-1',
        briefDraftId: 'brief-1',
        goal: 'book a demo',
        modelName: 'claude-haiku-4-5-20251001',
        budgetCents: 99,
        maxToolCalls: 7,
        maxWallSecs: 30,
      },
    );

    const opts = runAgentMock.mock.calls[0]?.[0] as {
      modelName: string;
      budgetCents: number;
      maxToolCalls: number;
      maxWallSecs: number;
      tools: AgentTool[];
      userPrompt: string;
    };
    expect(opts.modelName).toBe('claude-haiku-4-5-20251001');
    expect(opts.budgetCents).toBe(99);
    expect(opts.maxToolCalls).toBe(7);
    expect(opts.maxWallSecs).toBe(30);
    expect(opts.tools).toEqual([customTool]);
    // briefDraftId + goal threaded into the prompt builder
    expect(opts.userPrompt).toContain('brief-1');
    expect(opts.userPrompt).toContain('book a demo');
  });

  it('returns the runId, status, draftId, cost and tool count from runAgent', async () => {
    const deps = makeDeps({
      id: 'c1',
      orgId: 'o1',
      normalizedEmail: 'x@test.com',
      firstName: 'X',
      lastName: 'Y',
    });

    const result = await runSdrDrafter(deps, {
      orgId: 'o1',
      triggeredBy: 'u1',
      contactId: 'c1',
      runId: 'run-1',
    });

    expect(result).toEqual({
      runId: 'run-1',
      status: 'completed',
      reason: undefined,
      draftId: 'draft-1',
      costCents: 12,
      toolCallCount: 3,
    });
  });
});
