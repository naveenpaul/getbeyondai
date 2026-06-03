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

  it('persists sourcing + budgetCents on the campaign row (DB is the source of truth, not just the job)', async () => {
    const campaignCreate = vi.fn(async () => ({ id: 'c' }));
    const { service } = makeService({ campaign: { create: campaignCreate } });

    await service.create('org-1', 'user-1', {
      goal: 'g',
      sourcing: { provider: 'contact_list', listId: 'list-9' },
      budgetCents: 750,
    });

    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourcing: { provider: 'contact_list', listId: 'list-9' },
        budgetCents: 750,
      }),
    });
  });

  it('omits sourcing + budgetCents from the row when absent (→ SQL NULL)', async () => {
    const campaignCreate = vi.fn(async () => ({ id: 'c' }));
    const { service } = makeService({ campaign: { create: campaignCreate } });

    await service.create('org-1', 'user-1', { goal: 'g' });

    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ sourcing: expect.anything() }),
    });
    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ budgetCents: expect.anything() }),
    });
  });
});

describe('CampaignService.rerun', () => {
  const sourceRow = {
    id: 'camp-old',
    orgId: 'org-1',
    title: 'My campaign',
    goal: 'find lookalikes',
    status: 'failed',
    winsListId: 'wins-1',
    sourcing: { provider: 'contact_list', listId: 'list-1' },
    budgetCents: 500,
    createdBy: 'user-old',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('clones the persisted config into a new campaign and enqueues it', async () => {
    const campaignFindUnique = vi.fn(async () => sourceRow);
    const campaignCreate = vi.fn(async () => ({ id: 'camp-new' }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({
      campaign: { findUnique: campaignFindUnique, create: campaignCreate },
      send,
    });

    const result = await service.rerun('org-1', 'camp-old', 'user-runner');

    expect(result).toEqual({ campaignId: 'camp-new', status: 'running' });
    // New row keeps the original title/goal/wins/sourcing/budget; the
    // re-runner (not the original creator) is recorded as createdBy.
    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        createdBy: 'user-runner',
        title: 'My campaign',
        goal: 'find lookalikes',
        winsListId: 'wins-1',
        sourcing: { provider: 'contact_list', listId: 'list-1' },
        budgetCents: 500,
        status: 'running',
      }),
    });
    expect(send).toHaveBeenCalledWith(
      CAMPAIGN_RUN_QUEUE,
      expect.objectContaining({
        campaignId: 'camp-new',
        winsListId: 'wins-1',
        sourcing: { provider: 'contact_list', listId: 'list-1' },
        budgetCents: 500,
      }),
    );
  });

  it('clones a campaign that had no source or budget', async () => {
    const campaignFindUnique = vi.fn(async () => ({
      ...sourceRow,
      sourcing: null,
      budgetCents: null,
    }));
    const campaignCreate = vi.fn(async () => ({ id: 'camp-new2' }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({
      campaign: { findUnique: campaignFindUnique, create: campaignCreate },
      send,
    });

    await service.rerun('org-1', 'camp-old', 'user-runner');

    // Null source/budget round-trips to an omitted row + null job sourcing.
    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ sourcing: expect.anything() }),
    });
    expect(send).toHaveBeenCalledWith(
      CAMPAIGN_RUN_QUEUE,
      expect.objectContaining({ sourcing: null }),
    );
  });

  it('throws NotFoundException when the source campaign does not exist', async () => {
    const { service } = makeService({
      campaign: { findUnique: vi.fn(async () => null) },
    });

    await expect(service.rerun('org-1', 'missing', 'u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects + does not enqueue when the campaign belongs to another org', async () => {
    const send = vi.fn(async () => undefined);
    const { service } = makeService({
      campaign: {
        findUnique: vi.fn(async () => ({ ...sourceRow, orgId: 'org-OTHER' })),
      },
      send,
    });

    await expect(
      service.rerun('org-1', 'camp-old', 'u'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(send).not.toHaveBeenCalled();
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
        contacts: [],
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

  it('surfaces Stage 5 contacts on the candidate (source-agnostic)', async () => {
    const campaignWithContacts = {
      ...baseCampaign,
      candidates: [
        {
          name: 'Acme',
          domain: 'acme.com',
          linkedinUrl: null,
          fitScore: 0.9,
          rationale: 'good',
          draftId: null,
          contacts: [
            {
              sourceKind: 'snov',
              emailVerification: 'verified',
              contact: {
                firstName: 'Dana',
                lastName: 'Reed',
                title: 'VP Sales',
                normalizedEmail: 'dana@acme.com',
                linkedinUrl: 'https://linkedin.com/in/dana',
              },
            },
          ],
        },
      ],
    };
    const { service } = makeService({
      campaign: { findUnique: vi.fn(async () => campaignWithContacts) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.candidates[0]?.contacts).toEqual([
      {
        firstName: 'Dana',
        lastName: 'Reed',
        title: 'VP Sales',
        email: 'dana@acme.com',
        linkedinUrl: 'https://linkedin.com/in/dana',
        emailVerification: 'verified',
        source: 'snov',
      },
    ]);
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
          contacts: [],
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
