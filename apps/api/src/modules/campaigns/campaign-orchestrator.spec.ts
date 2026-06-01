import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { CampaignEvent, RunEvent } from '@getbeyond/shared';
import {
  CampaignOrchestrator,
  CAMPAIGN_TEAMMATE,
  ICP_PHASE,
  extractText,
  parseIcp,
  parseScore,
} from './campaign-orchestrator';
import { BudgetExceededError } from '../teammates/runtime/cost';
import type { LlmProvider } from '../teammates/runtime/llm-provider';
import type { CreateMessageResult } from '../teammates/runtime/llm-types';
import type {
  CandidateCompany,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from '../connectors/sourcing/sourcing-provider';
import type {
  runResearch,
  ResearchResult,
} from '../teammates/researcher/researcher.service';

/**
 * Orchestrator unit tests. The orchestrator is built for injection
 * (`CampaignOrchestratorDeps`): a fake Prisma, a fake LlmProvider (so the REAL
 * callModel chokepoint runs without a vendor SDK), a fake SourcingProvider, an
 * emitEvent that captures into an array, and a runResearch stub. No DB, no real
 * model. Explicit vitest imports because the project runs with `globals: false`.
 *
 * The orchestrator calls the real `callModel` (invariant #3 chokepoint), which
 * touches prisma.agentRun.findUnique/update + prisma.modelCall.create and prices
 * the call via the cost table — so the fake Prisma below mirrors what callModel
 * needs, and the model name stays a known-priced 'claude-sonnet-4-6'.
 */

// ─── Fake AgentRun store (shared by orchestrator + the real callModel) ──────

interface FakeAgentRun {
  id: string;
  orgId: string;
  teammate: string;
  triggeredBy: string;
  status: string;
  costCents: number;
  startedAt: Date;
  completedAt: Date | null;
  lastBeatAt: Date | null;
  inputContext: Record<string, unknown> | null;
}

interface FakeCandidateRow {
  campaignId: string;
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
  fitScore: number;
  rationale: string;
  draftId: string | null;
}

/**
 * One in-memory Prisma double covering every model + method the orchestrator
 * (and the real callModel it drives) touch. Each call site also lets a test
 * override the cost a model call bills so budget paths are deterministic.
 */
function makeFakePrisma(opts?: {
  /** Cost (cents) billed per scoring/ICP model call. Drives budget tests. */
  modelCallCostCents?: number;
  /** Wins-list members returned by readWins. */
  winMembers?: Array<{
    addedAt: Date;
    contact: { company: string | null; title: string | null };
  }>;
  /** Draft returned by readBrief, keyed by draftId. */
  drafts?: Record<
    string,
    {
      content: unknown;
      claims: Array<{
        id: string;
        text: string;
        citationId: string | null;
        abstained: boolean;
        confidence: number | null;
        citation: { url: string } | null;
      }>;
    } | null
  >;
}) {
  const runs = new Map<string, FakeAgentRun>();
  const candidates: FakeCandidateRow[] = [];
  const campaignUpdates: Array<{ id: string; status: string }> = [];
  let runCounter = 0;
  let modelCallCounter = 0;

  const prisma = {
    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `run-${++runCounter}`;
        const row: FakeAgentRun = {
          id,
          orgId: data.orgId as string,
          teammate: data.teammate as string,
          triggeredBy: data.triggeredBy as string,
          status: data.status as string,
          costCents: 0,
          startedAt: new Date(0),
          completedAt: null,
          lastBeatAt: null,
          inputContext:
            (data.inputContext as Record<string, unknown>) ?? null,
        };
        runs.set(id, row);
        return { ...row };
      }),
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: { costCents?: boolean };
        }) => {
          const row = runs.get(where.id);
          if (!row) return null;
          if (select?.costCents) return { costCents: row.costCents };
          return { ...row };
        },
      ),
      findFirst: vi.fn(async () => null),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: {
            status?: string;
            completedAt?: Date | null;
            costCents?: { increment: number };
            lastBeatAt?: Date;
            inputContext?: Record<string, unknown>;
          };
        }) => {
          const row = runs.get(where.id);
          if (!row) throw new Error(`agentRun ${where.id} not found`);
          if (data.status !== undefined) row.status = data.status;
          if (data.completedAt !== undefined) row.completedAt = data.completedAt;
          if (data.costCents?.increment !== undefined) {
            row.costCents += data.costCents.increment;
          }
          if (data.lastBeatAt !== undefined) row.lastBeatAt = data.lastBeatAt;
          if (data.inputContext !== undefined) {
            row.inputContext = data.inputContext as Record<string, unknown>;
          }
          return { ...row };
        },
      ),
    },
    modelCall: {
      create: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: `mc-${++modelCallCounter}`,
          ...data,
        }),
      ),
    },
    contactListMember: {
      findMany: vi.fn(async () => opts?.winMembers ?? []),
    },
    campaign: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status: string };
        }) => {
          campaignUpdates.push({ id: where.id, status: data.status });
          return { id: where.id, status: data.status };
        },
      ),
    },
    campaignCandidate: {
      create: vi.fn(async ({ data }: { data: FakeCandidateRow }) => {
        candidates.push({ ...data });
        return { ...data };
      }),
    },
    draft: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = opts?.drafts?.[where.id];
        return d ?? null;
      }),
      findMany: vi.fn(async () => []),
    },
    // Test handles.
    _runs: runs,
    _candidates: candidates,
    _campaignUpdates: campaignUpdates,
  };

  return prisma as unknown as PrismaClient & {
    _runs: Map<string, FakeAgentRun>;
    _candidates: FakeCandidateRow[];
    _campaignUpdates: Array<{ id: string; status: string }>;
    campaign: { update: ReturnType<typeof vi.fn> };
    agentRun: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
}

/**
 * Fake LlmProvider. callModel calls createMessage and prices it; we hand back
 * the JSON text the orchestrator's parsers expect, and a tunable token count so
 * a test can drive a known per-call cost (and therefore budget behavior).
 */
function makeFakeLlm(
  responder: (callIndex: number) => { text: string; outputTokens?: number },
): LlmProvider {
  let calls = 0;
  return {
    name: 'fake',
    capabilities: {
      promptCaching: false,
      toolUse: true,
      systemPrompt: true,
    } as LlmProvider['capabilities'],
    createMessage: vi.fn(async (): Promise<CreateMessageResult> => {
      const { text, outputTokens } = responder(calls++);
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end',
        usage: { inputTokens: 10, outputTokens: outputTokens ?? 10 },
        model: 'claude-sonnet-4-6',
      };
    }),
  };
}

function icpJson(): string {
  return JSON.stringify({
    summary: 'B2B SaaS, 11-50 employees, seed/series A',
    keywords: ['saas', 'b2b'],
    employeeCountMin: 11,
    employeeCountMax: 50,
    fundingStages: ['seed', 'series_a'],
    industries: ['software'],
    locations: ['US'],
  });
}

function candidate(name: string, domain: string | null = null): CandidateCompany {
  return {
    name,
    domain,
    linkedinUrl: null,
    employeeCount: null,
    fundingStage: null,
    raw: {},
  };
}

function makeSourcingProvider(
  candidates: CandidateCompany[],
  name = 'contact_list',
): SourcingProvider {
  return {
    name,
    findCandidates: vi.fn(
      async (): Promise<SourcingResult> => ({
        candidates,
        summary: `Read ${candidates.length} companies`,
      }),
    ),
  };
}

/** A completed Researcher run that produced a draft. */
function researchCompleted(draftId: string, costCents = 1): ResearchResult {
  return {
    runId: 'ignored',
    status: 'completed',
    draftId,
    costCents,
    toolCallCount: 1,
  };
}

function makeRunResearch(
  perCall: (target: string) => ResearchResult,
  emitForwarded?: RunEvent,
): typeof runResearch {
  return vi.fn(async (deps, input) => {
    if (emitForwarded && deps.emitEvent) deps.emitEvent(emitForwarded);
    return perCall(input.target);
  }) as unknown as typeof runResearch;
}

const SCORE_JSON = JSON.stringify({ fitScore: 0.8, rationale: 'Strong match.' });

describe('CampaignOrchestrator', () => {
  let events: CampaignEvent[];
  let emitEvent: (e: CampaignEvent) => void;

  beforeEach(() => {
    events = [];
    emitEvent = (e: CampaignEvent) => events.push(e);
  });

  const types = (): string[] => events.map((e) => e.type);

  describe('run() with no source attached (optional sourcing)', () => {
    it('derives the ICP, completes with 0 candidates, and prompts for a source', async () => {
      const prisma = makeFakePrisma();
      const llm = makeFakeLlm((i) => {
        if (i === 0) return { text: icpJson() };
        throw new Error('no scoring call should happen without a source');
      });

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        // No source attached.
        buildSourcingProvider: () => null,
        emitEvent,
        runResearch: makeRunResearch(() => researchCompleted('unused')),
      });

      const result = await orchestrator.run({
        campaignId: 'camp-1',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'Find lookalikes',
        winsListId: null,
        budgetCents: 1000,
      });

      expect(result).toEqual({
        status: 'completed',
        candidateCount: 0,
        costCents: 0,
      });
      // ICP is still derived + shown; no sourcing_started / candidate_qualified.
      expect(types()).toEqual([
        'campaign_started',
        'icp_derived',
        'sourcing_completed',
        'campaign_completed',
      ]);
      const sourcing = events.find((e) => e.type === 'sourcing_completed');
      expect(sourcing).toBeDefined();
      if (sourcing?.type === 'sourcing_completed') {
        expect(sourcing.data.candidateCount).toBe(0);
        expect(sourcing.data.summary).toMatch(/no candidate source/i);
      }
      expect(prisma._campaignUpdates).toContainEqual({
        id: 'camp-1',
        status: 'completed',
      });
    });
  });

  describe('run() happy path', () => {
    it('emits the pipeline events in order, ranks by fitScore desc, and marks completed', async () => {
      const prisma = makeFakePrisma({
        drafts: {
          'draft-a': {
            content: { brief: 'A' },
            claims: [
              {
                id: 'cl-1',
                text: 'A claim',
                citationId: 'cit-1',
                abstained: false,
                confidence: 0.9,
                citation: { url: 'https://a.example' },
              },
            ],
          },
          'draft-b': {
            content: { brief: 'B' },
            claims: [],
          },
        },
      });
      // ICP call (index 0), then a scoring call per candidate.
      const scores = [
        JSON.stringify({ fitScore: 0.3, rationale: 'weak' }),
        JSON.stringify({ fitScore: 0.9, rationale: 'strong' }),
      ];
      let scoreIdx = 0;
      const llm = makeFakeLlm((i) => {
        if (i === 0) return { text: icpJson() };
        return { text: scores[scoreIdx++] as string };
      });

      const provider = makeSourcingProvider([
        candidate('Alpha', 'alpha.com'),
        candidate('Beta', 'beta.com'),
      ]);
      const draftByTarget: Record<string, string> = {
        'Alpha (alpha.com)': 'draft-a',
        'Beta (beta.com)': 'draft-b',
      };
      const research = makeRunResearch((target) =>
        researchCompleted(draftByTarget[target] as string),
      );

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-1',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'Find lookalikes',
        winsListId: null,
        // concurrency 1 so the score responder order is deterministic.
        concurrency: 1,
        budgetCents: 1000,
      });

      expect(result.status).toBe('completed');
      expect(result.candidateCount).toBe(2);

      // Event ordering.
      expect(types()).toEqual([
        'campaign_started',
        'icp_derived',
        'sourcing_started',
        'sourcing_completed',
        'candidate_qualified',
        'candidate_qualified',
        'campaign_completed',
      ]);

      // Campaign row transitioned to completed.
      expect(prisma._campaignUpdates).toContainEqual({
        id: 'camp-1',
        status: 'completed',
      });

      // candidate_qualified events carry the right candidates (claims joined for
      // the one with a draft).
      const qualified = events.filter((e) => e.type === 'candidate_qualified');
      const alpha = qualified.find(
        (e) =>
          e.type === 'candidate_qualified' && e.data.candidate.name === 'Alpha',
      );
      expect(alpha && alpha.type === 'candidate_qualified').toBe(true);
      if (alpha && alpha.type === 'candidate_qualified') {
        expect(alpha.data.candidate.claims).toHaveLength(1);
        expect(alpha.data.candidate.claims[0]?.citationUrl).toBe(
          'https://a.example',
        );
      }
    });

    it('ranks completed campaign result by fitScore (the campaign_completed count == candidates)', async () => {
      const prisma = makeFakePrisma({
        drafts: { 'd1': { content: {}, claims: [] } },
      });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson() } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('Solo')]);
      const research = makeRunResearch(() => researchCompleted('d1'));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-2',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        budgetCents: 1000,
      });

      const completed = events.find((e) => e.type === 'campaign_completed');
      expect(completed?.type).toBe('campaign_completed');
      if (completed?.type === 'campaign_completed') {
        expect(completed.data.candidateCount).toBe(1);
      }
      expect(result.status).toBe('completed');
    });

    it('reads wins-list members (org-scoped) into the ICP prompt when a winsListId is given', async () => {
      const prisma = makeFakePrisma({
        winMembers: [
          { addedAt: new Date(0), contact: { company: 'WinCo', title: 'CEO' } },
        ],
        drafts: { 'd1': { content: {}, claims: [] } },
      });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson() } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('Cand')]);
      const research = makeRunResearch(() => researchCompleted('d1'));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      await orchestrator.run({
        campaignId: 'camp-3',
        orgId: 'org-9',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: 'wins-1',
        budgetCents: 1000,
      });

      expect(prisma.contactListMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { listId: 'wins-1', list: { orgId: 'org-9' } },
        }),
      );
    });

    it('persists the derived IcpSummary onto the ICP-derivation AgentRun for detail read-back', async () => {
      const prisma = makeFakePrisma({
        drafts: { 'd1': { content: {}, claims: [] } },
      });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson() } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('Cand')]);
      const research = makeRunResearch(() => researchCompleted('d1'));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      await orchestrator.run({
        campaignId: 'camp-4',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        budgetCents: 1000,
      });

      // The ICP run was created with the orchestrator teammate + phase marker,
      // then finalized with the icp summary stashed in inputContext.
      const icpRun = [...prisma._runs.values()].find(
        (r) => r.teammate === CAMPAIGN_TEAMMATE,
      );
      expect(icpRun).toBeDefined();
      expect(icpRun?.status).toBe('completed');
      const ctx = icpRun?.inputContext as Record<string, unknown>;
      expect(ctx.phase).toBe(ICP_PHASE);
      expect(ctx.campaignId).toBe('camp-4');
      expect((ctx.icp as { summary: string }).summary).toContain('B2B SaaS');
    });
  });

  describe('budget cap (invariant #8)', () => {
    it('stops qualifying once the per-campaign cost cap is reached', async () => {
      // Each model (ICP + scoring) call bills enough that after the first
      // candidate's scoring call the running spend hits the cap. The cost
      // billed comes from outputTokens via the real cost table; we read it back
      // from the per-candidate AgentRun.costCents in qualifyAll's ledger.
      const prisma = makeFakePrisma({
        drafts: {
          'd1': { content: {}, claims: [] },
          'd2': { content: {}, claims: [] },
          'd3': { content: {}, claims: [] },
        },
      });
      // outputTokens 200_000 on sonnet-4-6 ($15/M out) => 300 cents per call.
      const llm = makeFakeLlm((i) =>
        i === 0
          ? { text: icpJson(), outputTokens: 1 }
          : { text: SCORE_JSON, outputTokens: 200_000 },
      );
      const provider = makeSourcingProvider([
        candidate('A'),
        candidate('B'),
        candidate('C'),
      ]);
      const draftFor: Record<string, string> = {
        A: 'd1',
        B: 'd2',
        C: 'd3',
      };
      const research = makeRunResearch((target) =>
        researchCompleted(draftFor[target] as string, 0),
      );

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
        // Serialize so the budget ledger trips deterministically.
      });

      const result = await orchestrator.run({
        campaignId: 'camp-budget',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 300, // one candidate's scoring call (300¢) hits the cap.
      });

      // Fewer outcomes than candidates: the cap stopped the pipeline.
      const qualified = events.filter((e) => e.type === 'candidate_qualified');
      expect(qualified.length).toBeLessThan(3);
      expect(result.candidateCount).toBe(qualified.length);
      // Still completes (not failed).
      expect(result.status).toBe('completed');
      expect(prisma._campaignUpdates).toContainEqual({
        id: 'camp-budget',
        status: 'completed',
      });
    });

    it('clamps the per-candidate budget to the remaining campaign budget', async () => {
      // budgetCents 30 is below the per-candidate default (50). The single
      // candidate's research run must be invoked with the clamped budget (30),
      // not the default 50.
      const prisma = makeFakePrisma({
        drafts: { 'd1': { content: {}, claims: [] } },
      });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson(), outputTokens: 1 } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('Only')]);
      const research = vi.fn(async () =>
        researchCompleted('d1', 0),
      ) as unknown as typeof runResearch;

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      await orchestrator.run({
        campaignId: 'camp-clamp',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 30,
      });

      const mock = research as unknown as { mock: { calls: unknown[][] } };
      const passedInput = mock.mock.calls[0]?.[1] as { budgetCents: number };
      expect(passedInput.budgetCents).toBe(30);
    });
  });

  describe('fail-soft', () => {
    it('does not throw when ICP derivation fails; emits campaign_failed + sets status=failed', async () => {
      const prisma = makeFakePrisma();
      // The createMessage rejects → callModel throws → deriveIcp rethrows.
      const llm: LlmProvider = {
        name: 'fake',
        capabilities: {} as LlmProvider['capabilities'],
        createMessage: vi.fn(async () => {
          throw new Error('model exploded');
        }),
      };
      const provider = makeSourcingProvider([candidate('X')]);

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: makeRunResearch(() => researchCompleted('d1')),
      });

      const result = await orchestrator.run({
        campaignId: 'camp-fail',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        budgetCents: 1000,
      });

      expect(result).toEqual({
        status: 'failed',
        candidateCount: 0,
        costCents: 0,
      });
      expect(types()).toEqual(['campaign_started', 'campaign_failed']);
      const failed = events.find((e) => e.type === 'campaign_failed');
      if (failed?.type === 'campaign_failed') {
        expect(failed.data.message).toContain('model exploded');
      }
      expect(prisma._campaignUpdates).toContainEqual({
        id: 'camp-fail',
        status: 'failed',
      });
      // Sourcing was never reached.
      expect(provider.findCandidates).not.toHaveBeenCalled();
    });

    it('fails soft when the sourcing provider builder throws (e.g. apollo not configured)', async () => {
      const prisma = makeFakePrisma();
      const llm = makeFakeLlm(() => ({ text: icpJson() }));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => {
          throw new Error('Apollo sourcing is not configured.');
        },
        emitEvent,
        runResearch: makeRunResearch(() => researchCompleted('d1')),
      });

      const result = await orchestrator.run({
        campaignId: 'camp-src-fail',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        budgetCents: 1000,
      });

      expect(result.status).toBe('failed');
      // ICP derived first, then the failure on sourcing.
      expect(types()).toEqual([
        'campaign_started',
        'icp_derived',
        'campaign_failed',
      ]);
    });

    it('marks the ICP AgentRun failed (terminal) when the ICP model call throws', async () => {
      const prisma = makeFakePrisma();
      const llm: LlmProvider = {
        name: 'fake',
        capabilities: {} as LlmProvider['capabilities'],
        createMessage: vi.fn(async () => {
          throw new Error('boom');
        }),
      };

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => makeSourcingProvider([]),
        emitEvent,
        runResearch: makeRunResearch(() => researchCompleted('d1')),
      });

      await orchestrator.run({
        campaignId: 'camp-icp-run',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        budgetCents: 1000,
      });

      const icpRun = [...prisma._runs.values()].find(
        (r) => r.teammate === CAMPAIGN_TEAMMATE,
      );
      expect(icpRun?.status).toBe('failed');
      expect(icpRun?.completedAt).not.toBeNull();
    });
  });

  describe('tool_activity forwarding', () => {
    it("wraps the Researcher's emitted RunEvent as a campaign tool_activity event", async () => {
      const prisma = makeFakePrisma({
        drafts: { 'd1': { content: {}, claims: [] } },
      });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson() } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('A')]);
      const innerEvent: RunEvent = {
        type: 'tool_call_started',
        runId: 'run-x',
        at: new Date(0).toISOString(),
        data: { tool: 'brave_search', turn: 0 },
      } as unknown as RunEvent;
      const research = makeRunResearch(
        () => researchCompleted('d1'),
        innerEvent,
      );

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      await orchestrator.run({
        campaignId: 'camp-tool',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 1000,
      });

      const toolActivity = events.find((e) => e.type === 'tool_activity');
      expect(toolActivity).toBeDefined();
      if (toolActivity?.type === 'tool_activity') {
        expect(toolActivity.campaignId).toBe('camp-tool');
        expect(toolActivity.data.event).toEqual(innerEvent);
      }
    });
  });

  describe('abstain / failed candidate is still persisted', () => {
    it('persists a candidate with fitScore 0 + rationale when the Researcher abstains (no draft)', async () => {
      const prisma = makeFakePrisma();
      const llm = makeFakeLlm(() => ({ text: icpJson() }));
      const provider = makeSourcingProvider([candidate('Ghost')]);
      const research = vi.fn(async () => ({
        runId: 'r',
        status: 'abstained' as const,
        reason: 'no_sources_found',
        costCents: 2,
        toolCallCount: 0,
      })) as unknown as typeof runResearch;

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-abstain',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 1000,
      });

      expect(result.status).toBe('completed');
      expect(result.candidateCount).toBe(1);
      expect(prisma._candidates).toHaveLength(1);
      const row = prisma._candidates[0];
      expect(row?.fitScore).toBe(0);
      expect(row?.rationale).toContain('No cited brief produced');
      expect(row?.rationale).toContain('no_sources_found');
      expect(row?.draftId).toBeNull();
    });

    it('persists a candidate with fitScore 0 when the Researcher run throws', async () => {
      const prisma = makeFakePrisma();
      const llm = makeFakeLlm(() => ({ text: icpJson() }));
      const provider = makeSourcingProvider([candidate('Boom')]);
      const research = vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof runResearch;

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-throw',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 1000,
      });

      expect(result.status).toBe('completed');
      expect(prisma._candidates).toHaveLength(1);
      expect(prisma._candidates[0]?.fitScore).toBe(0);
      expect(prisma._candidates[0]?.rationale).toContain('Research failed');
      expect(prisma._candidates[0]?.rationale).toContain('network down');
    });

    it('keeps the brief but records a zero score when the scoring call trips the per-run budget', async () => {
      const prisma = makeFakePrisma({
        drafts: { 'd1': { content: { brief: 'x' }, claims: [] } },
      });
      // ICP call cheap; scoring call bills way over the per-candidate clamp so
      // callModel throws BudgetExceededError, which scoreCandidate catches.
      const llm = makeFakeLlm((i) =>
        i === 0
          ? { text: icpJson(), outputTokens: 1 }
          : { text: SCORE_JSON, outputTokens: 10_000_000 },
      );
      const provider = makeSourcingProvider([candidate('Pricey')]);
      const research = makeRunResearch(() => researchCompleted('d1', 0));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-score-budget',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 10_000, // campaign budget high; per-candidate clamp is 50.
      });

      // Did not crash the campaign; candidate persisted with the budget reason.
      expect(result.status).toBe('completed');
      expect(prisma._candidates).toHaveLength(1);
      expect(prisma._candidates[0]?.fitScore).toBe(0);
      expect(prisma._candidates[0]?.rationale).toContain(
        'per-candidate budget exhausted',
      );
    });
  });

  describe('scoring rethrow', () => {
    it('fails the campaign soft when the scoring call throws a non-budget error', async () => {
      const prisma = makeFakePrisma({
        drafts: { 'd1': { content: { brief: 'x' }, claims: [] } },
      });
      // ICP call (i=0) succeeds; scoring call (i=1) throws a non-budget error
      // from createMessage → callModel rethrows → scoreCandidate rethrows
      // (line 586) → qualifyOne → run()'s catch → campaign_failed.
      let n = 0;
      const llm: LlmProvider = {
        name: 'fake',
        capabilities: {} as LlmProvider['capabilities'],
        createMessage: vi.fn(async () => {
          if (n++ === 0) {
            return {
              content: [{ type: 'text', text: icpJson() }],
              stopReason: 'end',
              usage: { inputTokens: 1, outputTokens: 1 },
              model: 'claude-sonnet-4-6',
            } as CreateMessageResult;
          }
          throw new Error('scoring transport error');
        }),
      };
      const provider = makeSourcingProvider([candidate('A')]);
      const research = makeRunResearch(() => researchCompleted('d1', 0));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-score-throw',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 10_000,
      });

      expect(result.status).toBe('failed');
      expect(types()).toContain('campaign_failed');
      const failed = events.find((e) => e.type === 'campaign_failed');
      if (failed?.type === 'campaign_failed') {
        expect(failed.data.message).toContain('scoring transport error');
      }
    });
  });

  describe('wins with a contact title', () => {
    it('derives the ICP from wins that carry a contact title', async () => {
      const prisma = makeFakePrisma({
        winMembers: [
          {
            addedAt: new Date(0),
            contact: { company: 'WinCo', title: 'VP Sales' },
          },
          // duplicate company (case-insensitive) is collapsed by readWins.
          { addedAt: new Date(1), contact: { company: 'winco', title: 'CTO' } },
          // blank company is skipped.
          { addedAt: new Date(2), contact: { company: '  ', title: 'x' } },
        ],
        drafts: { 'd1': { content: {}, claims: [] } },
      });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson() } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('Cand')]);
      const research = makeRunResearch(() => researchCompleted('d1'));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-wins-title',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: 'wins-1',
        concurrency: 1,
        budgetCents: 1000,
      });

      expect(result.status).toBe('completed');
      // The ICP-derivation user prompt rendered the win with its title — assert
      // it reached createMessage (the prompt-builder's title branch ran).
      const llmMock = llm.createMessage as unknown as {
        mock: { calls: Array<[{ messages: Array<{ content: Array<{ text: string }> }> }]> };
      };
      const icpCallText =
        llmMock.mock.calls[0]?.[0].messages[0]?.content[0]?.text ?? '';
      expect(icpCallText).toContain('WinCo');
      expect(icpCallText).toContain('VP Sales');
    });
  });

  describe('readBrief edge cases', () => {
    it('degrades to "(brief unavailable)" + empty claims when the draft row is missing', async () => {
      // draftId points at a draft the store returns null for.
      const prisma = makeFakePrisma({ drafts: { 'missing': null } });
      const llm = makeFakeLlm((i) =>
        i === 0 ? { text: icpJson() } : { text: SCORE_JSON },
      );
      const provider = makeSourcingProvider([candidate('A')]);
      const research = makeRunResearch(() => researchCompleted('missing'));

      const orchestrator = new CampaignOrchestrator({
        prisma,
        llm,
        buildSourcingProvider: () => provider,
        emitEvent,
        runResearch: research,
      });

      const result = await orchestrator.run({
        campaignId: 'camp-nobrief',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'g',
        winsListId: null,
        concurrency: 1,
        budgetCents: 1000,
      });

      // Scoring still ran (the brief text was the unavailable sentinel), so the
      // candidate carries the scored fitScore + the linked draftId.
      expect(result.status).toBe('completed');
      expect(prisma._candidates[0]?.draftId).toBe('missing');
      expect(prisma._candidates[0]?.fitScore).toBeGreaterThan(0);
    });
  });
});

// ─── Pure parsers ───────────────────────────────────────────────────────────

describe('extractText', () => {
  it('concatenates text blocks and trims, ignoring non-text blocks', () => {
    expect(
      extractText([
        { type: 'text', text: '  hello' },
        { type: 'tool_use' },
        { type: 'text', text: 'world  ' },
      ]),
    ).toBe('hello\nworld');
  });

  it('returns an empty string when there are no text blocks', () => {
    expect(extractText([{ type: 'tool_use' }])).toBe('');
    expect(extractText([])).toBe('');
  });
});

describe('parseIcp', () => {
  it('parses a valid strict-JSON ICP', () => {
    const out = parseIcp(icpJson());
    expect(out.summary).toContain('B2B SaaS');
    expect(out.keywords).toEqual(['saas', 'b2b']);
    expect(out.employeeCountMin).toBe(11);
    expect(out.employeeCountMax).toBe(50);
    expect(out.fundingStages).toEqual(['seed', 'series_a']);
    expect(out.industries).toEqual(['software']);
    expect(out.locations).toEqual(['US']);
  });

  it('strips a ```json markdown fence the model added', () => {
    const fenced = '```json\n' + icpJson() + '\n```';
    expect(parseIcp(fenced).summary).toContain('B2B SaaS');
  });

  it('falls back to a conservative empty ICP with the raw text as summary on malformed JSON', () => {
    const out = parseIcp('not json at all');
    expect(out.summary).toBe('not json at all');
    expect(out.keywords).toEqual([]);
    expect(out.employeeCountMin).toBeNull();
    expect(out.employeeCountMax).toBeNull();
    expect(out.fundingStages).toEqual([]);
    expect(out.industries).toEqual([]);
    expect(out.locations).toEqual([]);
  });

  it('uses the default summary when text is empty and JSON is absent', () => {
    expect(parseIcp('').summary).toBe('ICP could not be derived.');
  });

  it('coerces wrong-typed fields to safe defaults', () => {
    const out = parseIcp(
      JSON.stringify({
        summary: 42, // not a string → falls back to raw text
        keywords: ['ok', 7, '', 'two'], // filters non-strings + empties
        employeeCountMin: 'nope', // not a number → null
        employeeCountMax: Infinity, // not finite → null
        fundingStages: 'seed', // not an array → []
      }),
    );
    expect(out.keywords).toEqual(['ok', 'two']);
    expect(out.employeeCountMin).toBeNull();
    expect(out.employeeCountMax).toBeNull();
    expect(out.fundingStages).toEqual([]);
  });

  it('treats a top-level JSON array as malformed (object expected)', () => {
    const out = parseIcp('[1,2,3]');
    expect(out.summary).toBe('[1,2,3]');
    expect(out.keywords).toEqual([]);
  });
});

describe('parseScore', () => {
  it('parses a valid score + rationale', () => {
    expect(parseScore(JSON.stringify({ fitScore: 0.7, rationale: 'ok' }))).toEqual(
      { fitScore: 0.7, rationale: 'ok' },
    );
  });

  it('clamps fitScore into [0,1]', () => {
    expect(parseScore(JSON.stringify({ fitScore: 5, rationale: 'r' })).fitScore).toBe(
      1,
    );
    expect(
      parseScore(JSON.stringify({ fitScore: -3, rationale: 'r' })).fitScore,
    ).toBe(0);
  });

  it('degrades to score 0 with the raw text as rationale on malformed JSON', () => {
    expect(parseScore('garbage')).toEqual({
      fitScore: 0,
      rationale: 'garbage',
    });
  });

  it('uses the default rationale when text is empty', () => {
    expect(parseScore('')).toEqual({
      fitScore: 0,
      rationale: 'No rationale produced.',
    });
  });

  it('defaults missing fitScore to 0', () => {
    expect(parseScore(JSON.stringify({ rationale: 'no score' }))).toEqual({
      fitScore: 0,
      rationale: 'no score',
    });
  });
});
