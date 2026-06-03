import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type {
  CampaignEvent,
  IcpSummary,
  QualifiedCandidate,
  ResearcherDraftClaim,
  RunEvent,
} from '@getbeyond/shared';
import { callModel } from '../teammates/runtime/call-model';
import { BudgetExceededError } from '../teammates/runtime/cost';
import type { LlmProvider } from '../teammates/runtime/llm-provider';
import {
  RESEARCHER_NAME,
  runResearch,
  type ResearchResult,
} from '../teammates/researcher/researcher.service';
import {
  SourcingUnavailableError,
  type CandidateCompany,
  type FindCandidatesOptions,
  type IcpCriteria,
  type SourcingProvider,
} from '../connectors/sourcing/sourcing-provider';
import {
  waterfallSourcingService,
  type WaterfallConnector,
} from '../connectors/sourcing/waterfall-sourcing.service';
import { upsertContact } from '../contacts/contact-upsert';
import {
  campaignCompleted,
  campaignFailed,
  campaignStarted,
  candidateQualified,
  icpDerived,
  sourcingCompleted,
  sourcingStarted,
  toolActivity,
  type EmitCampaignEvent,
} from './campaign-events';
import {
  buildCandidateScoringUserPrompt,
  buildIcpDerivationUserPrompt,
  CANDIDATE_SCORING_SYSTEM_PROMPT,
  ICP_DERIVATION_SYSTEM_PROMPT,
  type WinExample,
} from './campaign.prompts';

/**
 * Campaign orchestrator — a FIXED GTM pipeline (NOT a generic planner).
 *
 *   1. deriveIcp(winsListId, goal): read the wins ContactList (scoped to org),
 *      synthesize an ICP via callModel. → icp_derived
 *   2. source: ContactListSourcingProvider.findCandidates(icp). →
 *      sourcing_started / sourcing_completed
 *   3. qualify + rank: for each candidate, with bounded concurrency AND the
 *      per-campaign cost budget (invariant #8), run the Researcher to produce a
 *      cited brief Draft, then score fit (0..1) + rationale via callModel.
 *      Persist a CampaignCandidate. → candidate_qualified per candidate, and
 *      each underlying Researcher RunEvent forwarded as tool_activity.
 *   4. rank by fitScore; set Campaign.status; → campaign_completed / failed.
 *
 * Reuse, not reimplementation: research is the existing Researcher
 * (`runResearch` → runtime tool-use loop). The orchestrator mints an AgentRun
 * per candidate, drives the Researcher on it, then reuses that same AgentRun for
 * the scoring `callModel` call so all cost lands on one auditable run. Both the
 * Researcher's spend and the scoring spend count against the per-campaign budget.
 *
 * Invariants honored:
 *   #1/#2 — the orchestrator reads ContactList rows for the wins seed and writes
 *           CampaignCandidate rows; the teammate (Researcher) itself touches only
 *           the runtime. Sourcing stays behind the SourcingProvider interface.
 *   #3    — every LLM call (ICP derivation, scoring, and the Researcher's own
 *           turns) goes through callModel.
 *   #4    — claims are read back from the Researcher's persisted Draft, where the
 *           runtime has already enforced cite-or-abstain.
 *   #8    — a hard per-campaign budget cap: before each candidate we check the
 *           cumulative cost; a candidate whose Researcher run trips the per-run
 *           budget contributes nothing further, and once the campaign-wide cap is
 *           reached the pipeline stops qualifying more candidates.
 */

/** Default tuning. Production callers stick with these. */
export const CAMPAIGN_DEFAULTS = {
  /** Candidate pool cap — how many companies to qualify. */
  candidateLimit: 25,
  /** Per-campaign hard cost cap (cents). Sum across all candidate runs. */
  budgetCents: 500,
  /** Per-candidate Researcher budget (cents). */
  perCandidateBudgetCents: 50,
  /** How many candidates the Researcher qualifies concurrently. */
  concurrency: 3,
  /** Model for ICP derivation + fit scoring. */
  modelName: 'claude-sonnet-4-6',
  /** Token cap for the (single-shot, JSON) ICP + scoring calls. */
  maxTokens: 1024,
} as const;

/** Stage 5 (contact sourcing) tuning. */
export const CONTACT_SOURCING_DEFAULTS = {
  /** Top-N qualified companies (by fitScore) to pull contacts for. */
  companies: 10,
  /** Cap on contacts pulled per company. */
  contactsPerCompany: 10,
  /** Waterfall threshold — chase a verified email across connectors. */
  threshold: 'verified' as const,
} as const;

/** A ranked candidate slimmed to what Stage 5 target-selection needs. */
export interface ContactTargetInput {
  candidateId: string;
  domain: string | null;
  fitScore: number;
}

/**
 * Pure Stage 5 gate: from ranked candidates, pick the companies to pull contacts
 * for — only QUALIFIED (fitScore > 0) companies that have a domain, capped to the
 * top `limit` (the input is already fit-ranked). Pulling contacts burns connector
 * credits, so this is where cost is bounded (eng-review A2).
 */
export function selectContactTargets(
  ranked: ReadonlyArray<ContactTargetInput>,
  limit: number,
): Array<{ candidateId: string; domain: string }> {
  const out: Array<{ candidateId: string; domain: string }> = [];
  for (const r of ranked) {
    if (out.length >= limit) break;
    if (r.fitScore > 0 && r.domain) {
      out.push({ candidateId: r.candidateId, domain: r.domain });
    }
  }
  return out;
}

export interface OrchestrateCampaignInput {
  campaignId: string;
  orgId: string;
  /** userId or 'system' — passed to the Researcher as triggeredBy. */
  triggeredBy: string;
  goal: string;
  /** ContactList of closed-won accounts the ICP is derived from. */
  winsListId: string | null;
  /** Overrides; defaults applied when absent. */
  budgetCents?: number;
  candidateLimit?: number;
  concurrency?: number;
  /** Resolved model (P5); defaults to the campaign default when absent. */
  modelName?: string;
}

export interface CampaignOrchestratorDeps {
  prisma: PrismaClient;
  llm: LlmProvider;
  /**
   * Builds the per-run SourcingProvider for this campaign. The worker wires the
   * concrete provider (ContactList or Apollo); tests pass a fake. Async because
   * Apollo discovery loads + decrypts the connector credentials. Throws
   * `SourcingUnavailableError` for benign, user-fixable problems (Apollo not
   * connected / key rejected) — the orchestrator surfaces those gracefully.
   */
  buildSourcingProvider: (orgId: string) => Promise<SourcingProvider | null>;
  /**
   * Builds the ordered enrichment connectors for Stage 5 (contact sourcing).
   * The worker loads the org's connected Snov/ZoomInfo accounts with decrypted
   * creds + breaker hooks, in priority order; tests inject fakes. **Optional** —
   * when absent (or it returns no connectors) Stage 5 is a no-op, so a campaign
   * with no enrichment connectors behaves exactly as before (regression-safe).
   */
  buildContactSourcers?: (orgId: string) => Promise<WaterfallConnector[]>;
  /**
   * Forwards a campaign event onto the bus. The worker wires this to the
   * RunEventBus; tests capture into an array.
   */
  emitEvent: EmitCampaignEvent;
  /**
   * Researcher entrypoint. Defaults to the real `runResearch`; tests inject a
   * stub so they don't drive the whole tool-use loop. Keeping it injectable is
   * how we unit-test the orchestrator's qualify/rank/budget logic in isolation
   * while still REUSING the real Researcher in production.
   */
  runResearch?: typeof runResearch;
}

export interface OrchestrateCampaignResult {
  status: 'completed' | 'failed';
  candidateCount: number;
  costCents: number;
}

interface DerivedIcp {
  icp: IcpCriteria;
  summary: IcpSummary;
}

interface QualifiedOutcome {
  candidate: QualifiedCandidate;
  /** CampaignCandidate.id — Stage 5 links sourced contacts to it. */
  candidateId: string;
  /** Company domain (may be null) — the waterfall's input for Stage 5. */
  domain: string | null;
  costCents: number;
}

export class CampaignOrchestrator {
  private readonly deps: CampaignOrchestratorDeps;
  // Resolved model for this run (set at run() start). Safe as instance state:
  // the orchestrator is constructed per-run, run() is called once, and every
  // candidate in a run uses the same model.
  private modelName: string = CAMPAIGN_DEFAULTS.modelName;

  constructor(deps: CampaignOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Drive a campaign from `running` to a terminal state. Emits the pipeline
   * events as it goes. Never throws for expected failure modes (sourcing
   * config, budget, LLM/research errors) — it records `campaign_failed` and
   * sets Campaign.status='failed'. It re-throws only on truly unexpected DB
   * errors so the worker's pg-boss retry can engage.
   */
  async run(
    input: OrchestrateCampaignInput,
  ): Promise<OrchestrateCampaignResult> {
    const { campaignId } = input;
    const budgetCents = input.budgetCents ?? CAMPAIGN_DEFAULTS.budgetCents;
    const candidateLimit =
      input.candidateLimit ?? CAMPAIGN_DEFAULTS.candidateLimit;
    const concurrency = input.concurrency ?? CAMPAIGN_DEFAULTS.concurrency;
    this.modelName = input.modelName ?? CAMPAIGN_DEFAULTS.modelName;

    this.deps.emitEvent(campaignStarted(campaignId, input.goal));

    try {
      // ── 1. Derive ICP ───────────────────────────────────────────────
      const derived = await this.deriveIcp(
        campaignId,
        input.orgId,
        input.triggeredBy,
        input.goal,
        input.winsListId,
      );
      this.deps.emitEvent(icpDerived(campaignId, derived.summary));

      // ── 2. Source candidate pool (optional) ─────────────────────────
      let provider: SourcingProvider | null;
      try {
        provider = await this.deps.buildSourcingProvider(input.orgId);
      } catch (err) {
        // A benign, user-fixable sourcing problem (Apollo not connected / key
        // rejected) — surface the actionable message and complete gracefully
        // instead of failing the campaign. Anything else bubbles to the outer
        // catch → campaign_failed (so pg-boss can retry real faults).
        if (err instanceof SourcingUnavailableError) {
          return await this.completeWithoutSource(campaignId, err.userMessage);
        }
        throw err;
      }
      if (provider === null) {
        // No source attached: the ICP is derived + shown, but there's no pool
        // to qualify. Complete gracefully and prompt the user to add a source.
        return await this.completeWithoutSource(
          campaignId,
          'No candidate source attached — connect Apollo to discover companies, or import a list.',
        );
      }
      this.deps.emitEvent(sourcingStarted(campaignId, provider.name));
      const opts: FindCandidatesOptions = { limit: candidateLimit };
      const sourced = await provider.findCandidates(derived.icp, opts);
      this.deps.emitEvent(
        sourcingCompleted(
          campaignId,
          sourced.summary,
          sourced.candidates.length,
        ),
      );

      // ── 3. Qualify + rank with bounded concurrency + budget cap ──────
      const outcomes = await this.qualifyAll({
        campaignId,
        orgId: input.orgId,
        triggeredBy: input.triggeredBy,
        icp: derived.icp,
        candidates: sourced.candidates,
        budgetCents,
        concurrency,
      });

      // ── 4. Rank, persist ordering, mark complete ────────────────────
      const ranked = [...outcomes].sort(
        (a, b) => b.candidate.fitScore - a.candidate.fitScore,
      );
      const costCents = outcomes.reduce((sum, o) => sum + o.costCents, 0);

      // ── 5. Source contacts at the top qualified companies (optional) ──
      // No-op unless the org has enrichment connectors wired; never fails the
      // campaign (best-effort enrichment over already-ranked companies).
      await this.sourceContacts({
        ranked,
        orgId: input.orgId,
        campaignId,
      });

      await this.deps.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'completed' },
      });
      this.deps.emitEvent(
        campaignCompleted(campaignId, ranked.length, costCents),
      );
      return {
        status: 'completed',
        candidateCount: ranked.length,
        costCents,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort transition to failed. If THIS write also throws (DB down),
      // let it bubble so pg-boss retries the whole job — but still surface the
      // failure on the stream first so subscribers stop waiting.
      this.deps.emitEvent(campaignFailed(campaignId, message));
      await this.deps.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'failed' },
      });
      return { status: 'failed', candidateCount: 0, costCents: 0 };
    }
  }

  /**
   * Graceful terminal for "ICP derived, but there's no usable candidate source"
   * — no source attached, or Apollo not connected / key rejected. Emits the
   * actionable message on the stream and completes the campaign with zero
   * candidates (not `failed`, since the user can fix it and re-run).
   */
  private async completeWithoutSource(
    campaignId: string,
    message: string,
  ): Promise<OrchestrateCampaignResult> {
    this.deps.emitEvent(sourcingCompleted(campaignId, message, 0));
    await this.deps.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'completed' },
    });
    this.deps.emitEvent(campaignCompleted(campaignId, 0, 0));
    return { status: 'completed', candidateCount: 0, costCents: 0 };
  }

  /**
   * Stage 5 — source contacts at the top qualified companies via the connector
   * waterfall, persisting each as a `Contact` linked to its `CampaignCandidate`.
   *
   * Best-effort enrichment: a per-company or per-contact failure is logged-by-
   * skip, never aborts the campaign. No-op when no enrichment connectors are
   * wired — so a campaign without Snov/ZoomInfo behaves exactly as before.
   */
  private async sourceContacts(params: {
    ranked: QualifiedOutcome[];
    orgId: string;
    campaignId: string;
  }): Promise<void> {
    const build = this.deps.buildContactSourcers;
    if (!build) return;
    const connectors = await build(params.orgId);
    if (connectors.length === 0) return;

    const targets = selectContactTargets(
      params.ranked.map((o) => ({
        candidateId: o.candidateId,
        domain: o.domain,
        fitScore: o.candidate.fitScore,
      })),
      CONTACT_SOURCING_DEFAULTS.companies,
    );

    for (const target of targets) {
      let sourced;
      try {
        sourced = await waterfallSourcingService.sourceCompany(
          target.domain as string,
          connectors,
          {
            threshold: CONTACT_SOURCING_DEFAULTS.threshold,
            contactsPerCompany: CONTACT_SOURCING_DEFAULTS.contactsPerCompany,
          },
        );
      } catch {
        // A company-level sourcing failure must not sink the campaign — the
        // companies are already ranked + persisted. Skip this company's contacts.
        continue;
      }

      for (const s of sourced) {
        try {
          const { contact } = await upsertContact(this.deps.prisma, {
            orgId: params.orgId,
            emailRaw: s.contact.emailRaw,
            sourceAccountId: s.sourceAccountId,
            sourceKind: s.sourceKind,
            externalId: s.contact.externalId,
            externalUrl: s.contact.externalUrl ?? null,
            fields: {
              firstName: s.contact.firstName,
              lastName: s.contact.lastName,
              title: s.contact.title,
              company: s.contact.company,
              linkedinUrl: s.contact.linkedinUrl,
            },
            rawPayload: s.contact.rawPayload as Prisma.InputJsonValue,
          });
          // Idempotent link (re-runs don't duplicate the join row).
          await this.deps.prisma.campaignCandidateContact.upsert({
            where: {
              campaignCandidateId_contactId: {
                campaignCandidateId: target.candidateId,
                contactId: contact.id,
              },
            },
            create: {
              campaignCandidateId: target.candidateId,
              contactId: contact.id,
              sourceKind: s.sourceKind,
              emailVerification: s.contact.emailVerification ?? null,
            },
            update: {},
          });
        } catch {
          // One bad contact (invalid email, write conflict) must not abort the
          // rest of the company's contacts. Skip it.
          continue;
        }
      }
    }
  }

  /**
   * Read the wins ContactList (org-scoped) and synthesize an ICP via callModel.
   * The model call runs on a dedicated AgentRun so its cost is audited like any
   * other LLM spend. When no wins list is attached, the ICP is derived from the
   * goal alone.
   */
  private async deriveIcp(
    campaignId: string,
    orgId: string,
    triggeredBy: string,
    goal: string,
    winsListId: string | null,
  ): Promise<DerivedIcp> {
    const wins = winsListId
      ? await this.readWins(orgId, winsListId)
      : [];

    const run = await this.deps.prisma.agentRun.create({
      data: {
        orgId,
        teammate: CAMPAIGN_TEAMMATE,
        triggeredBy,
        status: 'running',
        inputContext: { phase: ICP_PHASE, campaignId, goal, winsListId },
      },
    });

    let parsed: IcpParse;
    try {
      const result = await callModel(this.deps.prisma, this.deps.llm, {
        runId: run.id,
        modelName: this.modelName,
        systemPrompt: ICP_DERIVATION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildIcpDerivationUserPrompt(goal, wins),
              },
            ],
          },
        ],
        budgetCents: CAMPAIGN_DEFAULTS.budgetCents,
        maxTokens: CAMPAIGN_DEFAULTS.maxTokens,
      });
      parsed = parseIcp(extractText(result.message.content));
    } catch (err) {
      // Mark the one-shot ICP run terminal even on failure so the stale-run
      // reaper never touches it, then rethrow to fail the campaign.
      await this.deps.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'failed', completedAt: new Date() },
      });
      throw err;
    }

    const icp: IcpCriteria = {
      keywords: parsed.keywords,
      employeeCountMin: parsed.employeeCountMin,
      employeeCountMax: parsed.employeeCountMax,
      fundingStages: parsed.fundingStages,
      industries: parsed.industries,
      locations: parsed.locations,
    };
    const summary: IcpSummary = {
      summary: parsed.summary,
      keywords: parsed.keywords,
      employeeCountMax: parsed.employeeCountMax,
      fundingStages: parsed.fundingStages,
    };

    // Persist the derived IcpSummary on the (now terminal) AgentRun's
    // inputContext, tagged with campaignId. This is the read-back source for
    // GET /campaigns/:id's `icp` field — the icp_derived stream event ages out
    // of the bus buffer, but the campaign detail must show the ICP forever.
    await this.deps.prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        // Cast to Prisma.InputJsonValue: the literal holds a `string | null`
        // (winsListId) and the IcpSummary's `number | null`, which Prisma's
        // strict recursive JSON input type rejects even though both are valid
        // JSON. The values are plain JSON; the cast is sound.
        inputContext: {
          phase: ICP_PHASE,
          campaignId,
          goal,
          winsListId,
          icp: summary as unknown as Record<string, unknown>,
        } as Prisma.InputJsonValue,
      },
    });

    return { icp, summary };
  }

  private async readWins(
    orgId: string,
    winsListId: string,
  ): Promise<WinExample[]> {
    const members = await this.deps.prisma.contactListMember.findMany({
      // Scope through the list's orgId — a cross-org listId matches no rows.
      where: { listId: winsListId, list: { orgId } },
      include: { contact: true },
      orderBy: { addedAt: 'asc' },
      take: WINS_SAMPLE_LIMIT,
    });
    const byCompany = new Map<string, WinExample>();
    for (const member of members) {
      const company = (member.contact.company ?? '').trim();
      if (!company) continue;
      const key = company.toLowerCase();
      if (byCompany.has(key)) continue;
      byCompany.set(key, { company, title: member.contact.title ?? null });
    }
    return [...byCompany.values()];
  }

  /**
   * Qualify every candidate with bounded concurrency. A shared cost ledger
   * enforces the per-campaign budget (invariant #8): before a worker starts a
   * candidate it checks the running total; once the cap is reached, remaining
   * candidates are skipped (not qualified). Each candidate's spend (Researcher +
   * scoring) is added to the ledger as it completes.
   */
  private async qualifyAll(params: {
    campaignId: string;
    orgId: string;
    triggeredBy: string;
    icp: IcpCriteria;
    candidates: CandidateCompany[];
    budgetCents: number;
    concurrency: number;
  }): Promise<QualifiedOutcome[]> {
    const { candidates, budgetCents } = params;
    const total = candidates.length;
    const outcomes: QualifiedOutcome[] = [];
    let spentCents = 0;
    let nextIndex = 0;
    let budgetTripped = false;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= total) return;
        // Budget gate: if we've already hit the cap, stop pulling work.
        if (budgetTripped || spentCents >= budgetCents) {
          budgetTripped = true;
          return;
        }
        const candidate = candidates[index] as CandidateCompany;
        const outcome = await this.qualifyOne({
          campaignId: params.campaignId,
          orgId: params.orgId,
          triggeredBy: params.triggeredBy,
          icp: params.icp,
          candidate,
          // The per-candidate run can't be allowed to overshoot the remaining
          // campaign budget — clamp it to what's left.
          budgetCents: Math.min(
            CAMPAIGN_DEFAULTS.perCandidateBudgetCents,
            budgetCents - spentCents,
          ),
        });
        spentCents += outcome.costCents;
        outcomes.push(outcome);
        this.deps.emitEvent(
          candidateQualified(
            params.campaignId,
            outcome.candidate,
            outcomes.length - 1,
            total,
          ),
        );
        if (spentCents >= budgetCents) budgetTripped = true;
      }
    };

    const lanes = Math.max(1, Math.min(params.concurrency, total || 1));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return outcomes;
  }

  /**
   * Qualify a single candidate: run the Researcher on its company name/domain,
   * read back the cited brief, score fit via callModel (reusing the Researcher's
   * AgentRun so cost is consolidated), and persist a CampaignCandidate.
   *
   * The Researcher's RunEvents are forwarded to the campaign stream as
   * tool_activity. If the Researcher abstains/fails (no draft), the candidate
   * still gets persisted with fitScore 0 and a rationale explaining the gap —
   * so the chat shows it was looked at, not silently dropped.
   */
  private async qualifyOne(params: {
    campaignId: string;
    orgId: string;
    triggeredBy: string;
    icp: IcpCriteria;
    candidate: CandidateCompany;
    budgetCents: number;
  }): Promise<QualifiedOutcome> {
    const { candidate } = params;
    const target = candidate.domain
      ? `${candidate.name} (${candidate.domain})`
      : candidate.name;

    // Mint the candidate's AgentRun up front so the Researcher drives an
    // existing row (mirrors the Researcher controller's enqueue contract) and
    // the scoring callModel can reuse it.
    const run = await this.deps.prisma.agentRun.create({
      data: {
        orgId: params.orgId,
        teammate: RESEARCHER_NAME,
        triggeredBy: params.triggeredBy,
        status: 'running',
        inputContext: {
          phase: 'qualify_candidate',
          campaignId: params.campaignId,
          target,
        },
      },
    });

    const research = this.deps.runResearch ?? runResearch;
    let researchResult: ResearchResult;
    try {
      researchResult = await research(
        {
          prisma: this.deps.prisma,
          llm: this.deps.llm,
          // Forward the Researcher's granular RunEvents as campaign tool_activity.
          emitEvent: (event: RunEvent) =>
            this.deps.emitEvent(toolActivity(params.campaignId, event)),
        },
        {
          runId: run.id,
          orgId: params.orgId,
          triggeredBy: params.triggeredBy,
          target,
          modelName: this.modelName,
          budgetCents: params.budgetCents,
        },
      );
    } catch (err) {
      // A thrown Researcher error must not sink the whole campaign — record the
      // candidate as unqualified-on-error and move on. The AgentRun is left for
      // the reaper to finalize.
      const message = err instanceof Error ? err.message : String(err);
      const persisted = await this.persistCandidate({
        campaignId: params.campaignId,
        candidate,
        fitScore: 0,
        rationale: `Research failed: ${message}`,
        draftId: null,
        claims: [],
      });
      const costCents = await this.readRunCost(run.id);
      return {
        candidate: persisted.candidate,
        candidateId: persisted.candidateId,
        domain: candidate.domain,
        costCents,
      };
    }

    if (researchResult.status !== 'completed' || !researchResult.draftId) {
      const persisted = await this.persistCandidate({
        campaignId: params.campaignId,
        candidate,
        fitScore: 0,
        rationale: `No cited brief produced (${
          researchResult.reason ?? 'researcher abstained'
        }).`,
        draftId: null,
        claims: [],
      });
      return {
        candidate: persisted.candidate,
        candidateId: persisted.candidateId,
        domain: candidate.domain,
        costCents: researchResult.costCents,
      };
    }

    const { briefText, claims } = await this.readBrief(researchResult.draftId);

    // Score fit, reusing the candidate's AgentRun (so the scoring spend lands on
    // the same auditable run and counts toward the campaign budget). The run was
    // marked terminal by the Researcher loop; flip it back to running for the
    // extra call, then re-finalize.
    const score = await this.scoreCandidate({
      runId: run.id,
      icp: params.icp,
      candidateName: candidate.name,
      brief: briefText,
      budgetCents: params.budgetCents,
    });

    const persisted = await this.persistCandidate({
      campaignId: params.campaignId,
      candidate,
      fitScore: score.fitScore,
      rationale: score.rationale,
      draftId: researchResult.draftId,
      claims,
    });
    const costCents = await this.readRunCost(run.id);
    return {
      candidate: persisted.candidate,
      candidateId: persisted.candidateId,
      domain: candidate.domain,
      costCents,
    };
  }

  private async scoreCandidate(params: {
    runId: string;
    icp: IcpCriteria;
    candidateName: string;
    brief: string;
    budgetCents: number;
  }): Promise<{ fitScore: number; rationale: string }> {
    // Re-open the run for the scoring call (callModel reads costCents off it +
    // enforces the per-run budget), then re-finalize.
    await this.deps.prisma.agentRun.update({
      where: { id: params.runId },
      data: { status: 'running', completedAt: null },
    });
    try {
      const result = await callModel(this.deps.prisma, this.deps.llm, {
        runId: params.runId,
        modelName: this.modelName,
        systemPrompt: CANDIDATE_SCORING_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildCandidateScoringUserPrompt(
                  params.icp,
                  params.candidateName,
                  params.brief,
                ),
              },
            ],
          },
        ],
        budgetCents: params.budgetCents,
        maxTokens: CAMPAIGN_DEFAULTS.maxTokens,
      });
      return parseScore(extractText(result.message.content));
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        // The scoring call tripped the per-run budget — keep the brief but
        // record an honest low/zero score with the reason.
        return {
          fitScore: 0,
          rationale: 'Scoring skipped: per-candidate budget exhausted.',
        };
      }
      throw err;
    } finally {
      await this.deps.prisma.agentRun.update({
        where: { id: params.runId },
        data: { status: 'completed', completedAt: new Date() },
      });
    }
  }

  /** Read the Researcher Draft's content (as text) + its cited claims. */
  private async readBrief(
    draftId: string,
  ): Promise<{ briefText: string; claims: ResearcherDraftClaim[] }> {
    const draft = await this.deps.prisma.draft.findUnique({
      where: { id: draftId },
      include: { claims: { include: { citation: true } } },
    });
    if (!draft) {
      return { briefText: '(brief unavailable)', claims: [] };
    }
    const claims: ResearcherDraftClaim[] = draft.claims.map((c) => ({
      id: c.id,
      text: c.text,
      citationId: c.citationId,
      citationUrl: c.citation?.url ?? null,
      abstained: c.abstained,
      confidence: c.confidence,
    }));
    return {
      briefText: JSON.stringify(draft.content),
      claims,
    };
  }

  private async persistCandidate(params: {
    campaignId: string;
    candidate: CandidateCompany;
    fitScore: number;
    rationale: string;
    draftId: string | null;
    claims: ResearcherDraftClaim[];
  }): Promise<{ candidate: QualifiedCandidate; candidateId: string }> {
    const created = await this.deps.prisma.campaignCandidate.create({
      data: {
        campaignId: params.campaignId,
        name: params.candidate.name,
        domain: params.candidate.domain,
        linkedinUrl: params.candidate.linkedinUrl,
        fitScore: params.fitScore,
        rationale: params.rationale,
        draftId: params.draftId,
      },
      select: { id: true },
    });
    return {
      candidate: {
        name: params.candidate.name,
        domain: params.candidate.domain,
        linkedinUrl: params.candidate.linkedinUrl,
        fitScore: params.fitScore,
        rationale: params.rationale,
        claims: params.claims,
      },
      candidateId: created.id,
    };
  }

  private async readRunCost(runId: string): Promise<number> {
    const run = await this.deps.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { costCents: true },
    });
    return run?.costCents ?? 0;
  }
}

/** AgentRun.teammate value for the orchestrator's own (non-Researcher) calls. */
export const CAMPAIGN_TEAMMATE = 'campaign-orchestrator';
/** inputContext.phase marker for the ICP-derivation AgentRun (detail read-back). */
export const ICP_PHASE = 'derive_icp';
/** How many wins-list companies to feed the ICP-derivation prompt. */
const WINS_SAMPLE_LIMIT = 50;

interface IcpParse {
  summary: string;
  keywords: string[];
  employeeCountMin: number | null;
  employeeCountMax: number | null;
  fundingStages: string[];
  industries: string[];
  locations: string[];
}

/**
 * Extract the concatenated text from a model response's content blocks. The
 * ICP + scoring turns are plain-text (no tools), so we read the text out.
 */
export function extractText(
  content: { type: string; text?: string }[],
): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Parse the model's STRICT-JSON ICP. Tolerant of a leading/trailing markdown
 * fence the model may add despite instructions; falls back to a conservative
 * empty ICP (with the raw text as summary) if the JSON can't be parsed, so a
 * malformed model turn degrades to "sourced everything, derived nothing" rather
 * than crashing the campaign.
 */
export function parseIcp(text: string): IcpParse {
  const obj = tryParseJson(text);
  return {
    summary: asString(obj?.summary) ?? (text || 'ICP could not be derived.'),
    keywords: asStringArray(obj?.keywords),
    employeeCountMin: asNumberOrNull(obj?.employeeCountMin),
    employeeCountMax: asNumberOrNull(obj?.employeeCountMax),
    fundingStages: asStringArray(obj?.fundingStages),
    industries: asStringArray(obj?.industries),
    locations: asStringArray(obj?.locations),
  };
}

/**
 * Parse the model's STRICT-JSON fit score. fitScore is clamped to [0,1]; an
 * unparseable turn degrades to score 0 with the raw text as the rationale.
 */
export function parseScore(text: string): {
  fitScore: number;
  rationale: string;
} {
  const obj = tryParseJson(text);
  const raw = asNumberOrNull(obj?.fitScore);
  const fitScore = raw === null ? 0 : clamp01(raw);
  const rationale =
    asString(obj?.rationale) ?? (text || 'No rationale produced.');
  return { fitScore, rationale };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = stripFence(text);
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip a ```json ... ``` markdown fence if the model wrapped its output. */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? (fenced[1] as string).trim() : text.trim();
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export type { CampaignEvent };
