import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import { CampaignService, deriveTitle } from './campaign.service';
import { CAMPAIGN_RUN_QUEUE } from './campaign.worker';
import { CAMPAIGN_TEAMMATE, ICP_PHASE } from './campaign-orchestrator';

/**
 * CampaignService unit tests with a mocked PrismaService + QueueService. No DB.
 * Explicit vitest imports — `globals: false`.
 */

function makeService(overrides?: {
  campaign?: Partial<Record<string, ReturnType<typeof vi.fn>>>;
  draft?: Partial<Record<string, ReturnType<typeof vi.fn>>>;
  agentRun?: Partial<Record<string, ReturnType<typeof vi.fn>>>;
  send?: ReturnType<typeof vi.fn>;
}) {
  const campaignCreate = overrides?.campaign?.create ?? vi.fn();
  const campaignFindMany = overrides?.campaign?.findMany ?? vi.fn();
  const campaignFindUnique = overrides?.campaign?.findUnique ?? vi.fn();
  const draftFindMany = overrides?.draft?.findMany ?? vi.fn(async () => []);
  const agentRunFindFirst =
    overrides?.agentRun?.findFirst ?? vi.fn(async () => null);
  const send = overrides?.send ?? vi.fn(async () => undefined);

  const prisma = {
    campaign: {
      create: campaignCreate,
      findMany: campaignFindMany,
      findUnique: campaignFindUnique,
    },
    draft: { findMany: draftFindMany },
    agentRun: { findFirst: agentRunFindFirst },
  } as unknown as PrismaService;

  const queue = { send } as unknown as QueueService;
  const service = new CampaignService(prisma, queue);
  return {
    service,
    campaignCreate,
    campaignFindMany,
    campaignFindUnique,
    draftFindMany,
    agentRunFindFirst,
    send,
  };
}

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('CampaignService.create', () => {
  it('persists a running Campaign and enqueues the orchestrator job', async () => {
    const campaignCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'camp-new',
      ...data,
    }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({ campaign: { create: campaignCreate }, send });

    const result = await service.create('org-1', 'user-1', {
      goal: 'Find lookalikes of our wins',
      winsListId: 'wins-1',
      sourcing: { provider: 'contact_list', listId: 'list-1' },
      budgetCents: 500,
    });

    expect(result).toEqual({ campaignId: 'camp-new', status: 'running' });

    // Campaign persisted with session identity, status running, derived title.
    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        createdBy: 'user-1',
        goal: 'Find lookalikes of our wins',
        status: 'running',
        winsListId: 'wins-1',
        title: 'Find lookalikes of our wins',
      }),
    });

    // Job enqueued on the campaign-run queue with the campaignId.
    expect(send).toHaveBeenCalledWith(
      CAMPAIGN_RUN_QUEUE,
      expect.objectContaining({
        campaignId: 'camp-new',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        goal: 'Find lookalikes of our wins',
        winsListId: 'wins-1',
        sourcing: { provider: 'contact_list', listId: 'list-1' },
        budgetCents: 500,
      }),
    );
  });

  it('defaults winsListId to null when omitted', async () => {
    const campaignCreate = vi.fn(async () => ({ id: 'c' }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({ campaign: { create: campaignCreate }, send });

    await service.create('org-1', 'user-1', {
      goal: 'g',
      sourcing: { provider: 'contact_list', listId: 'l' },
    });

    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ winsListId: null }),
    });
    expect(send).toHaveBeenCalledWith(
      CAMPAIGN_RUN_QUEUE,
      expect.objectContaining({ winsListId: null }),
    );
  });
});

describe('CampaignService.list', () => {
  it('returns org-scoped summaries with candidate counts, newest first', async () => {
    const campaignFindMany = vi.fn(async () => [
      {
        id: 'c1',
        title: 'T1',
        goal: 'g1',
        status: 'completed',
        createdAt: NOW,
        updatedAt: NOW,
        _count: { candidates: 3 },
      },
    ]);
    const { service } = makeService({ campaign: { findMany: campaignFindMany } });

    const result = await service.list('org-1');

    expect(campaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(result.items).toEqual([
      {
        id: 'c1',
        title: 'T1',
        goal: 'g1',
        status: 'completed',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        candidateCount: 3,
      },
    ]);
  });
});

describe('CampaignService.detail', () => {
  const baseCampaign = {
    id: 'c1',
    orgId: 'org-1',
    title: 'T',
    goal: 'g',
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW,
    _count: { candidates: 1 },
    candidates: [
      {
        name: 'Acme',
        domain: 'acme.com',
        linkedinUrl: null,
        fitScore: 0.9,
        rationale: 'good',
        draftId: 'd1',
      },
    ],
  };

  it('joins candidate claims from their linked Draft + the derived ICP', async () => {
    const campaignFindUnique = vi.fn(async () => baseCampaign);
    const draftFindMany = vi.fn(async () => [
      {
        id: 'd1',
        claims: [
          {
            id: 'cl-1',
            text: 'A claim',
            citationId: 'cit-1',
            abstained: false,
            confidence: 0.8,
            citation: { url: 'https://acme.example' },
          },
        ],
      },
    ]);
    const agentRunFindFirst = vi.fn(async () => ({
      inputContext: {
        phase: ICP_PHASE,
        campaignId: 'c1',
        icp: {
          summary: 'B2B SaaS',
          keywords: ['saas'],
          employeeCountMax: 50,
          fundingStages: ['seed'],
        },
      },
    }));
    const { service } = makeService({
      campaign: { findUnique: campaignFindUnique },
      draft: { findMany: draftFindMany },
      agentRun: { findFirst: agentRunFindFirst },
    });

    const result = await service.detail('org-1', 'c1');

    expect(result.campaign.id).toBe('c1');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.claims).toEqual([
      {
        id: 'cl-1',
        text: 'A claim',
        citationId: 'cit-1',
        citationUrl: 'https://acme.example',
        abstained: false,
        confidence: 0.8,
      },
    ]);
    expect(result.icp?.summary).toBe('B2B SaaS');

    // ICP lookup is org-scoped + filtered to this campaign's derive-icp run.
    expect(agentRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'org-1',
          teammate: CAMPAIGN_TEAMMATE,
        }),
      }),
    );
  });

  it('maps a claim with no citation to citationUrl null', async () => {
    const campaignFindUnique = vi.fn(async () => baseCampaign);
    const draftFindMany = vi.fn(async () => [
      {
        id: 'd1',
        claims: [
          {
            id: 'cl-1',
            text: 'abstained claim',
            citationId: null,
            abstained: true,
            confidence: null,
            citation: null,
          },
        ],
      },
    ]);
    const { service } = makeService({
      campaign: { findUnique: campaignFindUnique },
      draft: { findMany: draftFindMany },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.candidates[0]?.claims[0]?.citationUrl).toBeNull();
    expect(result.candidates[0]?.claims[0]?.abstained).toBe(true);
  });

  it('returns null ICP when no derive-icp AgentRun exists yet', async () => {
    const { service } = makeService({
      campaign: { findUnique: vi.fn(async () => baseCampaign) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.icp).toBeNull();
    // The draft had no claims joined → empty claims array, not undefined.
    expect(result.candidates[0]?.claims).toEqual([]);
  });

  it('returns null ICP when the AgentRun inputContext has no icp object', async () => {
    const { service } = makeService({
      campaign: { findUnique: vi.fn(async () => baseCampaign) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: {
        findFirst: vi.fn(async () => ({
          inputContext: { phase: ICP_PHASE, campaignId: 'c1' },
        })),
      },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.icp).toBeNull();
  });

  it('throws NotFoundException when the campaign does not exist', async () => {
    const { service } = makeService({
      campaign: { findUnique: vi.fn(async () => null) },
    });

    await expect(service.detail('org-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when the campaign belongs to another org (cross-org isolation)', async () => {
    const { service } = makeService({
      campaign: {
        findUnique: vi.fn(async () => ({ ...baseCampaign, orgId: 'org-OTHER' })),
      },
    });

    await expect(service.detail('org-1', 'c1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('handles a candidate with no draftId (no claims join attempted for it)', async () => {
    const campaign = {
      ...baseCampaign,
      candidates: [
        {
          name: 'NoDraft',
          domain: null,
          linkedinUrl: null,
          fitScore: 0,
          rationale: 'abstained',
          draftId: null,
        },
      ],
    };
    const draftFindMany = vi.fn(async () => []);
    const { service } = makeService({
      campaign: { findUnique: vi.fn(async () => campaign) },
      draft: { findMany: draftFindMany },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.candidates[0]?.claims).toEqual([]);
    // No draft ids → draft.findMany short-circuits (not called).
    expect(draftFindMany).not.toHaveBeenCalled();
  });
});

describe('deriveTitle', () => {
  it('collapses whitespace and returns short goals verbatim', () => {
    expect(deriveTitle('  Find   lookalikes  ')).toBe('Find lookalikes');
  });

  it('truncates long goals with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to "Untitled campaign" for an empty goal', () => {
    expect(deriveTitle('   ')).toBe('Untitled campaign');
  });
});
