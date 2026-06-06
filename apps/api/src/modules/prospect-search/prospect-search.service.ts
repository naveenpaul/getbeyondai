import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ProspectSearchDetailResponse,
  ProspectSearchListResponse,
  ProspectSearchSummary,
  CreateProspectSearchRequest,
  CreateProspectSearchResponse,
  DiscoveredCompany,
  IcpCriteriaInput,
  IcpSummary,
  QualifiedProspect,
  ResearcherDraftClaim,
  SourcingConfig,
} from '@getbeyond/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import {
  PROSPECT_SEARCH_RUN_QUEUE,
  type ProspectSearchRunJobPayload,
} from './prospect-search.worker';
import { PROSPECT_SEARCH_TEAMMATE, ICP_PHASE } from './prospect-search-orchestrator';

/**
 * ProspectSearch reads + create/enqueue. The orchestration itself runs on the
 * ProspectSearchWorker (pg-boss) — this service owns the synchronous API surface:
 * mint the ProspectSearch row, enqueue the run, and serve list/detail reads scoped to
 * the caller's org.
 *
 * Identity (orgId, createdBy) is always passed in by the controller from the
 * session — never from the request body (invariant: identity from session).
 */
@Injectable()
export class ProspectSearchService {
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
   * Create a ProspectSearch (status='running') and enqueue the orchestrator job.
   * Returns the prospectSearchId so the caller can open the SSE stream immediately.
   */
  async create(
    orgId: string,
    createdBy: string,
    req: CreateProspectSearchRequest,
  ): Promise<CreateProspectSearchResponse> {
    const winsListId = req.winsListId ?? null;
    const sourcing = req.sourcing ?? null;
    const icpCriteria = req.icpCriteria ?? null;
    const prospectSearch = await this.prisma.prospectSearch.create({
      data: {
        orgId,
        title: req.title ?? deriveTitle(req.goal),
        goal: req.goal,
        status: 'running',
        winsListId,
        createdBy,
        // Persist the run config so the prospectSearch can be re-run faithfully and so
        // detail can report what it used. Omit (→ SQL NULL) when absent rather
        // than threading Prisma.JsonNull through.
        ...(sourcing !== null ? { sourcing } : {}),
        // IcpCriteriaInput is an interface (no implicit index signature), so it
        // isn't assignable to Prisma's recursive InputJsonValue without a cast.
        // The value is plain JSON; the cast is sound.
        ...(icpCriteria !== null
          ? { icpCriteria: icpCriteria as unknown as Prisma.InputJsonValue }
          : {}),
        ...(req.budgetCents !== undefined ? { budgetCents: req.budgetCents } : {}),
      },
    });

    await this.queue.send<ProspectSearchRunJobPayload>(PROSPECT_SEARCH_RUN_QUEUE, {
      prospectSearchId: prospectSearch.id,
      orgId,
      triggeredBy: createdBy,
      goal: req.goal,
      winsListId,
      sourcing,
      icpCriteria,
      budgetCents: req.budgetCents,
    });

    return { prospectSearchId: prospectSearch.id, status: 'running' };
  }

  /**
   * Re-run a prospectSearch: clone its persisted run config (goal, title, wins list,
   * sourcing, budget) into a NEW prospectSearch and enqueue a fresh run. Cloning (vs
   * re-enqueueing in place) keeps the original prospectSearch's record + history
   * intact and yields a new prospectSearchId the caller can stream. Org-scoped: a
   * prospectSearch from another org is invisible (NotFound semantics via the guard
   * below). Returns the new prospectSearch, exactly like create.
   */
  async rerun(
    orgId: string,
    prospectSearchId: string,
    createdBy: string,
  ): Promise<CreateProspectSearchResponse> {
    const source = await this.prisma.prospectSearch.findUnique({
      where: { id: prospectSearchId },
    });
    if (!source) {
      throw new NotFoundException(`ProspectSearch ${prospectSearchId} not found`);
    }
    if (source.orgId !== orgId) {
      throw new ForbiddenException('ProspectSearch belongs to another org');
    }

    return this.create(orgId, createdBy, {
      goal: source.goal,
      title: source.title,
      winsListId: source.winsListId,
      sourcing: (source.sourcing as unknown as SourcingConfig | null) ?? null,
      icpCriteria:
        (source.icpCriteria as unknown as IcpCriteriaInput | null) ?? null,
      ...(source.budgetCents !== null
        ? { budgetCents: source.budgetCents }
        : {}),
    });
  }

  /** List the org's prospectSearches, newest first, with a live prospect count. */
  async list(orgId: string): Promise<ProspectSearchListResponse> {
    const prospectSearches = await this.prisma.prospectSearch.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { prospects: true } } },
    });
    return {
      items: prospectSearches.map((c) =>
        toSummary(c, c._count.prospects),
      ),
    };
  }

  /**
   * ProspectSearch detail: the prospectSearch summary, the derived ICP (read back from the
   * derive-icp AgentRun's inputContext), and the ranked prospects — each with
   * the cited claims joined from its linked Researcher Draft.
   */
  async detail(
    orgId: string,
    prospectSearchId: string,
  ): Promise<ProspectSearchDetailResponse> {
    const prospectSearch = await this.prisma.prospectSearch.findUnique({
      where: { id: prospectSearchId },
      include: {
        _count: { select: { prospects: true } },
        prospects: {
          orderBy: { fitScore: 'desc' },
          // Stage 5 contacts sourced at each company (source-agnostic — Snov,
          // ZoomInfo, …), surfaced so the user sees who to reach out to.
          include: { contacts: { include: { contact: true } } },
        },
      },
    });
    if (!prospectSearch) {
      throw new NotFoundException(`ProspectSearch ${prospectSearchId} not found`);
    }
    if (prospectSearch.orgId !== orgId) {
      throw new ForbiddenException('ProspectSearch belongs to another org');
    }

    // Join claims for every prospect's linked Draft in one query.
    const draftIds = prospectSearch.prospects
      .map((c) => c.draftId)
      .filter((id): id is string => id !== null);
    const claimsByDraft = await this.loadClaimsByDraft(draftIds);

    const prospects: QualifiedProspect[] = prospectSearch.prospects.map((c) => ({
      name: c.name,
      domain: c.domain,
      linkedinUrl: c.linkedinUrl,
      fitScore: c.fitScore,
      rationale: c.rationale,
      claims: c.draftId ? (claimsByDraft.get(c.draftId) ?? []) : [],
      contacts: c.contacts.map((link) => ({
        firstName: link.contact.firstName,
        lastName: link.contact.lastName,
        title: link.contact.title,
        email: link.contact.normalizedEmail,
        linkedinUrl: link.contact.linkedinUrl,
        emailVerification: link.emailVerification,
        source: link.sourceKind,
      })),
    }));

    const icp = await this.loadIcp(orgId, prospectSearchId);

    return {
      prospectSearch: toSummary(prospectSearch, prospectSearch._count.prospects),
      icp,
      discoveredCompanies: parseDiscoveredCompanies(
        prospectSearch.discoveredCompanies,
      ),
      prospects,
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
   * this prospectSearch (the orchestrator persists the IcpSummary into inputContext).
   * Returns null when the prospectSearch hasn't derived an ICP yet (still sourcing or
   * failed before ICP).
   */
  private async loadIcp(
    orgId: string,
    prospectSearchId: string,
  ): Promise<IcpSummary | null> {
    const run = await this.prisma.agentRun.findFirst({
      where: {
        orgId,
        teammate: PROSPECT_SEARCH_TEAMMATE,
        inputContext: { path: ['phase'], equals: ICP_PHASE },
        AND: [
          { inputContext: { path: ['prospectSearchId'], equals: prospectSearchId } },
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

/**
 * Parse the persisted `discoveredCompanies` JSON back into the typed shape.
 * Defensive: the column is untyped JSON, so we validate the array + each row's
 * `name` (required) and `domain` (string | null), dropping anything malformed
 * rather than trusting the blob. Returns `[]` for null / non-array / all-junk.
 */
function parseDiscoveredCompanies(value: unknown): DiscoveredCompany[] {
  if (!Array.isArray(value)) return [];
  const out: DiscoveredCompany[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.name !== 'string') continue;
    const domain =
      typeof row.domain === 'string'
        ? row.domain
        : row.domain === null
          ? null
          : null;
    out.push({ name: row.name, domain });
  }
  return out;
}

/** Map a ProspectSearch row (+ prospect count) to the public summary shape. */
function toSummary(
  c: {
    id: string;
    title: string;
    goal: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  },
  prospectCount: number,
): ProspectSearchSummary {
  return {
    id: c.id,
    title: c.title,
    goal: c.goal,
    status: c.status as ProspectSearchSummary['status'],
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    prospectCount,
  };
}

/** Derive a short display title from the goal when the user didn't supply one. */
export function deriveTitle(goal: string): string {
  const trimmed = goal.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed || 'Untitled prospectSearch';
  return trimmed.slice(0, TITLE_MAX_LEN - 1).trimEnd() + '…';
}

const TITLE_MAX_LEN = 80;
