import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import { ProspectSearchService, deriveTitle } from './prospect-search.service';
import { PROSPECT_SEARCH_RUN_QUEUE } from './prospect-search.worker';
import { PROSPECT_SEARCH_TEAMMATE, ICP_PHASE } from './prospect-search-orchestrator';

/**
 * ProspectSearchService unit tests with a mocked PrismaService + QueueService. No DB.
 * Explicit vitest imports — `globals: false`.
 */

function makeService(overrides?: {
  prospectSearch?: Partial<Record<string, ReturnType<typeof vi.fn>>>;
  draft?: Partial<Record<string, ReturnType<typeof vi.fn>>>;
  agentRun?: Partial<Record<string, ReturnType<typeof vi.fn>>>;
  send?: ReturnType<typeof vi.fn>;
}) {
  const prospectSearchCreate = overrides?.prospectSearch?.create ?? vi.fn();
  const prospectSearchFindMany = overrides?.prospectSearch?.findMany ?? vi.fn();
  const prospectSearchFindUnique = overrides?.prospectSearch?.findUnique ?? vi.fn();
  const draftFindMany = overrides?.draft?.findMany ?? vi.fn(async () => []);
  const agentRunFindFirst =
    overrides?.agentRun?.findFirst ?? vi.fn(async () => null);
  const send = overrides?.send ?? vi.fn(async () => undefined);

  const prisma = {
    prospectSearch: {
      create: prospectSearchCreate,
      findMany: prospectSearchFindMany,
      findUnique: prospectSearchFindUnique,
    },
    draft: { findMany: draftFindMany },
    agentRun: { findFirst: agentRunFindFirst },
  } as unknown as PrismaService;

  const queue = { send } as unknown as QueueService;
  const service = new ProspectSearchService(prisma, queue);
  return {
    service,
    prospectSearchCreate,
    prospectSearchFindMany,
    prospectSearchFindUnique,
    draftFindMany,
    agentRunFindFirst,
    send,
  };
}

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('ProspectSearchService.create', () => {
  it('persists a running ProspectSearch and enqueues the orchestrator job', async () => {
    const prospectSearchCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'camp-new',
      ...data,
    }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({ prospectSearch: { create: prospectSearchCreate }, send });

    const result = await service.create('org-1', 'user-1', {
      goal: 'Find lookalikes of our wins',
      winsListId: 'wins-1',
      sourcing: { provider: 'contact_list', listId: 'list-1' },
      budgetCents: 500,
    });

    expect(result).toEqual({ prospectSearchId: 'camp-new', status: 'running' });

    // ProspectSearch persisted with session identity, status running, derived title.
    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        createdBy: 'user-1',
        goal: 'Find lookalikes of our wins',
        status: 'running',
        winsListId: 'wins-1',
        title: 'Find lookalikes of our wins',
      }),
    });

    // Job enqueued on the prospect-search-run queue with the prospectSearchId.
    expect(send).toHaveBeenCalledWith(
      PROSPECT_SEARCH_RUN_QUEUE,
      expect.objectContaining({
        prospectSearchId: 'camp-new',
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
    const prospectSearchCreate = vi.fn(async () => ({ id: 'c' }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({ prospectSearch: { create: prospectSearchCreate }, send });

    await service.create('org-1', 'user-1', {
      goal: 'g',
      sourcing: { provider: 'contact_list', listId: 'l' },
    });

    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ winsListId: null }),
    });
    expect(send).toHaveBeenCalledWith(
      PROSPECT_SEARCH_RUN_QUEUE,
      expect.objectContaining({ winsListId: null }),
    );
  });

  it('persists sourcing + budgetCents on the prospectSearch row (DB is the source of truth, not just the job)', async () => {
    const prospectSearchCreate = vi.fn(async () => ({ id: 'c' }));
    const { service } = makeService({ prospectSearch: { create: prospectSearchCreate } });

    await service.create('org-1', 'user-1', {
      goal: 'g',
      sourcing: { provider: 'contact_list', listId: 'list-9' },
      budgetCents: 750,
    });

    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourcing: { provider: 'contact_list', listId: 'list-9' },
        budgetCents: 750,
      }),
    });
  });

  it('omits sourcing + budgetCents from the row when absent (→ SQL NULL)', async () => {
    const prospectSearchCreate = vi.fn(async () => ({ id: 'c' }));
    const { service } = makeService({ prospectSearch: { create: prospectSearchCreate } });

    await service.create('org-1', 'user-1', { goal: 'g' });

    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ sourcing: expect.anything() }),
    });
    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ budgetCents: expect.anything() }),
    });
  });
});

describe('ProspectSearchService.rerun', () => {
  const sourceRow = {
    id: 'camp-old',
    orgId: 'org-1',
    title: 'My prospectSearch',
    goal: 'find lookalikes',
    status: 'failed',
    winsListId: 'wins-1',
    sourcing: { provider: 'contact_list', listId: 'list-1' },
    budgetCents: 500,
    createdBy: 'user-old',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('clones the persisted config into a new prospectSearch and enqueues it', async () => {
    const prospectSearchFindUnique = vi.fn(async () => sourceRow);
    const prospectSearchCreate = vi.fn(async () => ({ id: 'camp-new' }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({
      prospectSearch: { findUnique: prospectSearchFindUnique, create: prospectSearchCreate },
      send,
    });

    const result = await service.rerun('org-1', 'camp-old', 'user-runner');

    expect(result).toEqual({ prospectSearchId: 'camp-new', status: 'running' });
    // New row keeps the original title/goal/wins/sourcing/budget; the
    // re-runner (not the original creator) is recorded as createdBy.
    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        createdBy: 'user-runner',
        title: 'My prospectSearch',
        goal: 'find lookalikes',
        winsListId: 'wins-1',
        sourcing: { provider: 'contact_list', listId: 'list-1' },
        budgetCents: 500,
        status: 'running',
      }),
    });
    expect(send).toHaveBeenCalledWith(
      PROSPECT_SEARCH_RUN_QUEUE,
      expect.objectContaining({
        prospectSearchId: 'camp-new',
        winsListId: 'wins-1',
        sourcing: { provider: 'contact_list', listId: 'list-1' },
        budgetCents: 500,
      }),
    );
  });

  it('clones a prospectSearch that had no source or budget', async () => {
    const prospectSearchFindUnique = vi.fn(async () => ({
      ...sourceRow,
      sourcing: null,
      budgetCents: null,
    }));
    const prospectSearchCreate = vi.fn(async () => ({ id: 'camp-new2' }));
    const send = vi.fn(async () => undefined);
    const { service } = makeService({
      prospectSearch: { findUnique: prospectSearchFindUnique, create: prospectSearchCreate },
      send,
    });

    await service.rerun('org-1', 'camp-old', 'user-runner');

    // Null source/budget round-trips to an omitted row + null job sourcing.
    expect(prospectSearchCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ sourcing: expect.anything() }),
    });
    expect(send).toHaveBeenCalledWith(
      PROSPECT_SEARCH_RUN_QUEUE,
      expect.objectContaining({ sourcing: null }),
    );
  });

  it('throws NotFoundException when the source prospectSearch does not exist', async () => {
    const { service } = makeService({
      prospectSearch: { findUnique: vi.fn(async () => null) },
    });

    await expect(service.rerun('org-1', 'missing', 'u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects + does not enqueue when the prospectSearch belongs to another org', async () => {
    const send = vi.fn(async () => undefined);
    const { service } = makeService({
      prospectSearch: {
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

describe('ProspectSearchService.list', () => {
  it('returns org-scoped summaries with prospect counts, newest first', async () => {
    const prospectSearchFindMany = vi.fn(async () => [
      {
        id: 'c1',
        title: 'T1',
        goal: 'g1',
        status: 'completed',
        createdAt: NOW,
        updatedAt: NOW,
        _count: { prospects: 3 },
      },
    ]);
    const { service } = makeService({ prospectSearch: { findMany: prospectSearchFindMany } });

    const result = await service.list('org-1');

    expect(prospectSearchFindMany).toHaveBeenCalledWith(
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
        prospectCount: 3,
      },
    ]);
  });
});

describe('ProspectSearchService.detail', () => {
  const baseProspectSearch = {
    id: 'c1',
    orgId: 'org-1',
    title: 'T',
    goal: 'g',
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW,
    _count: { prospects: 1 },
    prospects: [
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

  it('joins prospect claims from their linked Draft + the derived ICP', async () => {
    const prospectSearchFindUnique = vi.fn(async () => baseProspectSearch);
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
        prospectSearchId: 'c1',
        icp: {
          summary: 'B2B SaaS',
          keywords: ['saas'],
          employeeCountMax: 50,
          fundingStages: ['seed'],
        },
      },
    }));
    const { service } = makeService({
      prospectSearch: { findUnique: prospectSearchFindUnique },
      draft: { findMany: draftFindMany },
      agentRun: { findFirst: agentRunFindFirst },
    });

    const result = await service.detail('org-1', 'c1');

    expect(result.prospectSearch.id).toBe('c1');
    expect(result.prospects).toHaveLength(1);
    expect(result.prospects[0]?.claims).toEqual([
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

    // ICP lookup is org-scoped + filtered to this prospectSearch's derive-icp run.
    expect(agentRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'org-1',
          teammate: PROSPECT_SEARCH_TEAMMATE,
        }),
      }),
    );
  });

  it('surfaces Stage 5 contacts on the prospect (source-agnostic)', async () => {
    const prospectSearchWithContacts = {
      ...baseProspectSearch,
      prospects: [
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
      prospectSearch: { findUnique: vi.fn(async () => prospectSearchWithContacts) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.prospects[0]?.contacts).toEqual([
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
    const prospectSearchFindUnique = vi.fn(async () => baseProspectSearch);
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
      prospectSearch: { findUnique: prospectSearchFindUnique },
      draft: { findMany: draftFindMany },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.prospects[0]?.claims[0]?.citationUrl).toBeNull();
    expect(result.prospects[0]?.claims[0]?.abstained).toBe(true);
  });

  it('returns null ICP when no derive-icp AgentRun exists yet', async () => {
    const { service } = makeService({
      prospectSearch: { findUnique: vi.fn(async () => baseProspectSearch) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.icp).toBeNull();
    // The draft had no claims joined → empty claims array, not undefined.
    expect(result.prospects[0]?.claims).toEqual([]);
  });

  it('returns null ICP when the AgentRun inputContext has no icp object', async () => {
    const { service } = makeService({
      prospectSearch: { findUnique: vi.fn(async () => baseProspectSearch) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: {
        findFirst: vi.fn(async () => ({
          inputContext: { phase: ICP_PHASE, prospectSearchId: 'c1' },
        })),
      },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.icp).toBeNull();
  });

  it('throws NotFoundException when the prospectSearch does not exist', async () => {
    const { service } = makeService({
      prospectSearch: { findUnique: vi.fn(async () => null) },
    });

    await expect(service.detail('org-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when the prospectSearch belongs to another org (cross-org isolation)', async () => {
    const { service } = makeService({
      prospectSearch: {
        findUnique: vi.fn(async () => ({ ...baseProspectSearch, orgId: 'org-OTHER' })),
      },
    });

    await expect(service.detail('org-1', 'c1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('handles a prospect with no draftId (no claims join attempted for it)', async () => {
    const prospectSearch = {
      ...baseProspectSearch,
      prospects: [
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
      prospectSearch: { findUnique: vi.fn(async () => prospectSearch) },
      draft: { findMany: draftFindMany },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.prospects[0]?.claims).toEqual([]);
    // No draft ids → draft.findMany short-circuits (not called).
    expect(draftFindMany).not.toHaveBeenCalled();
  });

  it('returns the persisted discovered companies, dropping malformed rows', async () => {
    const prospectSearch = {
      ...baseProspectSearch,
      discoveredCompanies: [
        { name: 'Acme', domain: 'acme.com' },
        { name: 'Globex', domain: null },
        { domain: 'noname.com' }, // dropped — no name
        'garbage', // dropped — not an object
        { name: 'Initech', domain: 42 }, // domain coerced to null
      ],
    };
    const { service } = makeService({
      prospectSearch: { findUnique: vi.fn(async () => prospectSearch) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.discoveredCompanies).toEqual([
      { name: 'Acme', domain: 'acme.com' },
      { name: 'Globex', domain: null },
      { name: 'Initech', domain: null },
    ]);
  });

  it('returns an empty discovered-companies list when none persisted', async () => {
    const { service } = makeService({
      prospectSearch: { findUnique: vi.fn(async () => baseProspectSearch) },
      draft: { findMany: vi.fn(async () => []) },
      agentRun: { findFirst: vi.fn(async () => null) },
    });

    const result = await service.detail('org-1', 'c1');
    expect(result.discoveredCompanies).toEqual([]);
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

  it('falls back to "Untitled prospectSearch" for an empty goal', () => {
    expect(deriveTitle('   ')).toBe('Untitled prospectSearch');
  });
});
