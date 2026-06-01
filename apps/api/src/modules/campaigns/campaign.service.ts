import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CampaignDetailResponse,
  CampaignListResponse,
  CampaignSummary,
  CreateCampaignRequest,
  CreateCampaignResponse,
  IcpSummary,
  QualifiedCandidate,
  ResearcherDraftClaim,
} from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import {
  CAMPAIGN_RUN_QUEUE,
  type CampaignRunJobPayload,
} from './campaign.worker';
import { CAMPAIGN_TEAMMATE, ICP_PHASE } from './campaign-orchestrator';

/**
 * Campaign reads + create/enqueue. The orchestration itself runs on the
 * CampaignWorker (pg-boss) — this service owns the synchronous API surface:
 * mint the Campaign row, enqueue the run, and serve list/detail reads scoped to
 * the caller's org.
 *
 * Identity (orgId, createdBy) is always passed in by the controller from the
 * session — never from the request body (invariant: identity from session).
 */
@Injectable()
export class CampaignService {
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  /**
   * Create a Campaign (status='running') and enqueue the orchestrator job.
   * Returns the campaignId so the caller can open the SSE stream immediately.
   */
  async create(
    orgId: string,
    createdBy: string,
    req: CreateCampaignRequest,
  ): Promise<CreateCampaignResponse> {
    const winsListId = req.winsListId ?? null;
    const campaign = await this.prisma.campaign.create({
      data: {
        orgId,
        title: req.title ?? deriveTitle(req.goal),
        goal: req.goal,
        status: 'running',
        winsListId,
        createdBy,
      },
    });

    await this.queue.send<CampaignRunJobPayload>(CAMPAIGN_RUN_QUEUE, {
      campaignId: campaign.id,
      orgId,
      triggeredBy: createdBy,
      goal: req.goal,
      winsListId,
      sourcing: req.sourcing,
      budgetCents: req.budgetCents,
    });

    return { campaignId: campaign.id, status: 'running' };
  }

  /** List the org's campaigns, newest first, with a live candidate count. */
  async list(orgId: string): Promise<CampaignListResponse> {
    const campaigns = await this.prisma.campaign.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { candidates: true } } },
    });
    return {
      items: campaigns.map((c) =>
        toSummary(c, c._count.candidates),
      ),
    };
  }

  /**
   * Campaign detail: the campaign summary, the derived ICP (read back from the
   * derive-icp AgentRun's inputContext), and the ranked candidates — each with
   * the cited claims joined from its linked Researcher Draft.
   */
  async detail(
    orgId: string,
    campaignId: string,
  ): Promise<CampaignDetailResponse> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        _count: { select: { candidates: true } },
        candidates: { orderBy: { fitScore: 'desc' } },
      },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }
    if (campaign.orgId !== orgId) {
      throw new ForbiddenException('Campaign belongs to another org');
    }

    // Join claims for every candidate's linked Draft in one query.
    const draftIds = campaign.candidates
      .map((c) => c.draftId)
      .filter((id): id is string => id !== null);
    const claimsByDraft = await this.loadClaimsByDraft(draftIds);

    const candidates: QualifiedCandidate[] = campaign.candidates.map((c) => ({
      name: c.name,
      domain: c.domain,
      linkedinUrl: c.linkedinUrl,
      fitScore: c.fitScore,
      rationale: c.rationale,
      claims: c.draftId ? (claimsByDraft.get(c.draftId) ?? []) : [],
    }));

    const icp = await this.loadIcp(orgId, campaignId);

    return {
      campaign: toSummary(campaign, campaign._count.candidates),
      icp,
      candidates,
    };
  }

  private async loadClaimsByDraft(
    draftIds: string[],
  ): Promise<Map<string, ResearcherDraftClaim[]>> {
    const byDraft = new Map<string, ResearcherDraftClaim[]>();
    if (draftIds.length === 0) return byDraft;
    const drafts = await this.prisma.draft.findMany({
      where: { id: { in: draftIds } },
      include: { claims: { include: { citation: true } } },
    });
    for (const draft of drafts) {
      byDraft.set(
        draft.id,
        draft.claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          citationId: claim.citationId,
          citationUrl: claim.citation?.url ?? null,
          abstained: claim.abstained,
          confidence: claim.confidence,
        })),
      );
    }
    return byDraft;
  }

  /**
   * Read the derived ICP back from the most recent ICP-derivation AgentRun for
   * this campaign (the orchestrator persists the IcpSummary into inputContext).
   * Returns null when the campaign hasn't derived an ICP yet (still sourcing or
   * failed before ICP).
   */
  private async loadIcp(
    orgId: string,
    campaignId: string,
  ): Promise<IcpSummary | null> {
    const run = await this.prisma.agentRun.findFirst({
      where: {
        orgId,
        teammate: CAMPAIGN_TEAMMATE,
        inputContext: { path: ['phase'], equals: ICP_PHASE },
        AND: [
          { inputContext: { path: ['campaignId'], equals: campaignId } },
        ],
      },
      orderBy: { startedAt: 'desc' },
      select: { inputContext: true },
    });
    if (!run) return null;
    const ctx = run.inputContext as Record<string, unknown> | null;
    const icp = ctx?.icp;
    if (!icp || typeof icp !== 'object') return null;
    return icp as unknown as IcpSummary;
  }
}

/** Map a Campaign row (+ candidate count) to the public summary shape. */
function toSummary(
  c: {
    id: string;
    title: string;
    goal: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  },
  candidateCount: number,
): CampaignSummary {
  return {
    id: c.id,
    title: c.title,
    goal: c.goal,
    status: c.status as CampaignSummary['status'],
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    candidateCount,
  };
}

/** Derive a short display title from the goal when the user didn't supply one. */
export function deriveTitle(goal: string): string {
  const trimmed = goal.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed || 'Untitled campaign';
  return trimmed.slice(0, TITLE_MAX_LEN - 1).trimEnd() + '…';
}

const TITLE_MAX_LEN = 80;
