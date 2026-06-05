import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  CredentialManager,
  CredentialManagerError,
} from '../connectors/credential-manager';
import { ApolloSourcingProvider } from '../connectors/sourcing/apollo-sourcing.provider';
import { ZoomInfoSourcingProvider } from '../connectors/sourcing/zoominfo-sourcing.provider';
import { ContactListSourcingProvider } from '../connectors/sourcing/contact-list-sourcing.provider';
import { SourcingUnavailableError } from '../connectors/sourcing/sourcing-provider';
import type { IcpCriteria } from '../connectors/sourcing/sourcing-provider';
import {
  PdlSourcingProvider,
  type PdlCompanySearcher,
} from '../connectors/sourcing/pdl-sourcing.provider';
import { PdlEnrichmentProvider } from '../connectors/enrichment/pdl-enrichment.provider';
import type { PdlCompanyEnricher } from '../connectors/enrichment/pdl-enrichment.provider';
import {
  buildContactSourcers,
  buildEnrichmentProvider,
  buildSourcingProvider,
} from './prospect-search.worker';

/**
 * Unit tests for the worker's `buildSourcingProvider` factory. The worker class
 * itself (pg-boss registration + DI wiring) is integration-tested; here we cover
 * the provider-selection branches with stubbed prisma + CredentialManager.
 * Explicit vitest imports — `globals: false`.
 */

const emptyPrisma = {} as unknown as PrismaService;
const noCreds = {} as unknown as CredentialManager;

/**
 * A prisma stub whose connectorAccount.findUnique returns `account` ONLY for the
 * apollo kind (null for zoominfo/others). Kind-aware so auto-discovery — which
 * now tries ZoomInfo before Apollo — correctly skips ZoomInfo (no account) and
 * lands on Apollo in these Apollo-focused tests.
 */
function prismaWithApolloAccount(
  account: { id: string } | null,
): PrismaService {
  return {
    connectorAccount: {
      findUnique: async ({
        where,
      }: {
        where: { orgId_kind: { kind: string } };
      }) => (where.orgId_kind.kind === 'apollo' ? account : null),
    },
  } as unknown as PrismaService;
}

/** A prisma stub returning an account for exactly the given connector kinds. */
function prismaWithKinds(kinds: Set<string>): PrismaService {
  return {
    connectorAccount: {
      findUnique: async ({
        where,
      }: {
        where: { orgId_kind: { kind: string } };
      }) =>
        kinds.has(where.orgId_kind.kind)
          ? { id: `acct-${where.orgId_kind.kind}` }
          : null,
    },
  } as unknown as PrismaService;
}

describe('buildSourcingProvider', () => {
  it('builds a ContactListSourcingProvider for the contact_list provider', async () => {
    const provider = await buildSourcingProvider(emptyPrisma, noCreds, 'org-1', {
      provider: 'contact_list',
      listId: 'list-1',
    });
    expect(provider).toBeInstanceOf(ContactListSourcingProvider);
  });

  it('returns null when no source is attached and no discovery provider is connected', async () => {
    const prisma = prismaWithApolloAccount(null);
    expect(
      await buildSourcingProvider(prisma, noCreds, 'org-1', null),
    ).toBeNull();
  });

  it('auto-discovers via Apollo when no source is attached but Apollo is connected', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const credentials = {
      load: async () => ({ apiKey: 'secret' }),
    } as unknown as CredentialManager;

    const provider = await buildSourcingProvider(prisma, credentials, 'org-1', null);
    expect(provider).toBeInstanceOf(ApolloSourcingProvider);
  });

  it('builds an ApolloSourcingProvider for an explicit apollo source', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const credentials = {
      load: async () => ({ apiKey: 'secret' }),
    } as unknown as CredentialManager;

    const provider = await buildSourcingProvider(prisma, credentials, 'org-1', {
      provider: 'apollo',
    });
    expect(provider).toBeInstanceOf(ApolloSourcingProvider);
  });

  it('throws a user-fixable SourcingUnavailableError when Apollo is not connected', async () => {
    const prisma = prismaWithApolloAccount(null);
    await expect(
      buildSourcingProvider(prisma, noCreds, 'org-1', { provider: 'apollo' }),
    ).rejects.toBeInstanceOf(SourcingUnavailableError);
  });

  it('maps an expired Apollo key to a "reconnect" SourcingUnavailableError', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const credentials = credentialsThatThrow(
      new CredentialManagerError('expired', 'key rejected'),
    );

    await expect(
      buildSourcingProvider(prisma, credentials, 'org-1', { provider: 'apollo' }),
    ).rejects.toThrow(/reconnect Apollo/i);
  });

  it('maps a tripped circuit to a "temporarily unavailable" message', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const credentials = credentialsThatThrow(
      new CredentialManagerError('circuit_broken', 'cooldown'),
    );

    await expect(
      buildSourcingProvider(prisma, credentials, 'org-1', { provider: 'apollo' }),
    ).rejects.toThrow(/temporarily unavailable/i);
  });

  it('maps other credential errors to a generic "connect Apollo" message', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const credentials = credentialsThatThrow(
      new CredentialManagerError('not_found', 'gone'),
    );

    await expect(
      buildSourcingProvider(prisma, credentials, 'org-1', { provider: 'apollo' }),
    ).rejects.toThrow(/isn’t connected/i);
  });

  it('re-throws a non-credential error so pg-boss can retry', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const credentials = credentialsThatThrow(new Error('DB unreachable'));

    await expect(
      buildSourcingProvider(prisma, credentials, 'org-1', { provider: 'apollo' }),
    ).rejects.toThrow(/DB unreachable/);
  });
});

describe('buildSourcingProvider on Cloud (Apollo is self-host-only)', () => {
  it('refuses an explicit apollo source with a self-host-only message', async () => {
    // A prisma that would happily return an account — proving the gate fires
    // before any lookup.
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    await expect(
      buildSourcingProvider(
        prisma,
        noCreds,
        'org-1',
        { provider: 'apollo' },
        undefined,
        'cloud',
      ),
    ).rejects.toThrow(/self-hosted getbeyond only/i);
  });

  it('does not auto-discover via Apollo on Cloud (returns null)', async () => {
    const prisma = prismaWithApolloAccount({ id: 'acct-apollo' });
    const provider = await buildSourcingProvider(
      prisma,
      noCreds,
      'org-1',
      null,
      undefined,
      'cloud',
    );
    expect(provider).toBeNull();
  });

  it('still builds a contact_list provider on Cloud (only Apollo is gated)', async () => {
    const provider = await buildSourcingProvider(
      emptyPrisma,
      noCreds,
      'org-1',
      { provider: 'contact_list', listId: 'list-1' },
      undefined,
      'cloud',
    );
    expect(provider).toBeInstanceOf(ContactListSourcingProvider);
  });
});

describe('buildSourcingProvider — ZoomInfo discovery', () => {
  // A fake ZoomInfo searcher + factory; build-time doesn't call it, so an empty
  // stub suffices to assert provider selection.
  const fakeFactory = () => ({ searchCompanies: async () => ({ data: [] }) });
  const ziCreds = {
    load: async () => ({ clientId: 'id', clientSecret: 'sec' }),
  } as unknown as CredentialManager;

  it('builds a ZoomInfoSourcingProvider for an explicit zoominfo source', async () => {
    const prisma = prismaWithKinds(new Set(['zoominfo']));
    const provider = await buildSourcingProvider(
      prisma,
      ziCreds,
      'org-1',
      { provider: 'zoominfo' },
      undefined,
      'self_host',
      fakeFactory,
    );
    expect(provider).toBeInstanceOf(ZoomInfoSourcingProvider);
  });

  it('throws a user-fixable error when ZoomInfo is not connected', async () => {
    const prisma = prismaWithKinds(new Set());
    await expect(
      buildSourcingProvider(
        prisma,
        ziCreds,
        'org-1',
        { provider: 'zoominfo' },
        undefined,
        'self_host',
        fakeFactory,
      ),
    ).rejects.toThrow(/Connect ZoomInfo/i);
  });

  it('refuses explicit ZoomInfo on Cloud (self-host-only)', async () => {
    const prisma = prismaWithKinds(new Set(['zoominfo']));
    await expect(
      buildSourcingProvider(
        prisma,
        ziCreds,
        'org-1',
        { provider: 'zoominfo' },
        undefined,
        'cloud',
        fakeFactory,
      ),
    ).rejects.toThrow(/self-hosted getbeyond only/i);
  });

  it('maps expired ZoomInfo creds to a "reconnect" message', async () => {
    const prisma = prismaWithKinds(new Set(['zoominfo']));
    const credentials = credentialsThatThrow(
      new CredentialManagerError('expired', 'rejected'),
    );
    await expect(
      buildSourcingProvider(
        prisma,
        credentials,
        'org-1',
        { provider: 'zoominfo' },
        undefined,
        'self_host',
        fakeFactory,
      ),
    ).rejects.toThrow(/reconnect ZoomInfo/i);
  });

  it('auto-discovery PREFERS ZoomInfo when both ZoomInfo and Apollo are connected', async () => {
    const prisma = prismaWithKinds(new Set(['zoominfo', 'apollo']));
    const provider = await buildSourcingProvider(
      prisma,
      ziCreds,
      'org-1',
      null,
      undefined,
      'self_host',
      fakeFactory,
    );
    expect(provider).toBeInstanceOf(ZoomInfoSourcingProvider);
  });

  it('auto-discovery falls back to Apollo when ZoomInfo is not connected', async () => {
    const prisma = prismaWithKinds(new Set(['apollo']));
    const provider = await buildSourcingProvider(
      prisma,
      ziCreds,
      'org-1',
      null,
      undefined,
      'self_host',
      fakeFactory,
    );
    expect(provider).toBeInstanceOf(ApolloSourcingProvider);
  });
});

/** A prisma stub whose connectorAccount.findUnique returns an account only for
 * the given kinds (so we can simulate which connectors an org has connected). */
function prismaWithConnectorKinds(kinds: Set<string>): PrismaService {
  return {
    connectorAccount: {
      findUnique: async ({ where }: { where: { orgId_kind: { kind: string } } }) =>
        kinds.has(where.orgId_kind.kind)
          ? { id: `acct-${where.orgId_kind.kind}` }
          : null,
    },
  } as unknown as PrismaService;
}

describe('buildContactSourcers', () => {
  const creds = {
    load: async () => ({ clientId: 'i', clientSecret: 's' }),
  } as unknown as CredentialManager;
  // The built-in default priority; passed explicitly now that the order is a
  // per-org parameter rather than a module constant.
  const DEFAULT_PRIORITY = ['zoominfo', 'snov'] as const;

  it('returns no connectors when none are connected', async () => {
    const prisma = prismaWithConnectorKinds(new Set());
    expect(
      await buildContactSourcers(prisma, creds, 'org-1', DEFAULT_PRIORITY),
    ).toEqual([]);
  });

  it('builds a bound Snov WaterfallConnector when only Snov is connected', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov']));
    const connectors = await buildContactSourcers(
      prisma,
      creds,
      'org-1',
      DEFAULT_PRIORITY,
    );
    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.kind).toBe('snov');
    expect(connectors[0]!.accountId).toBe('acct-snov');
  });

  it('orders ZoomInfo before Snov when both are connected (default priority)', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov', 'zoominfo']));
    const connectors = await buildContactSourcers(
      prisma,
      creds,
      'org-1',
      DEFAULT_PRIORITY,
    );
    expect(connectors.map((c) => c.kind)).toEqual(['zoominfo', 'snov']);
  });

  it('honors a per-org priority that reorders Snov before ZoomInfo', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov', 'zoominfo']));
    const connectors = await buildContactSourcers(prisma, creds, 'org-1', [
      'snov',
      'zoominfo',
    ]);
    expect(connectors.map((c) => c.kind)).toEqual(['snov', 'zoominfo']);
  });

  it('sources nothing when the priority is empty (configured off)', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov', 'zoominfo']));
    expect(await buildContactSourcers(prisma, creds, 'org-1', [])).toEqual([]);
  });

  it('skips a connector whose credentials are rejected (best-effort, never fails)', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov']));
    const credentials = credentialsThatThrow(
      new CredentialManagerError('expired', 'key rejected'),
    );
    expect(
      await buildContactSourcers(prisma, credentials, 'org-1', DEFAULT_PRIORITY),
    ).toEqual([]);
  });

  it('re-throws a non-credential error so pg-boss can retry', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov']));
    const credentials = credentialsThatThrow(new Error('DB unreachable'));
    await expect(
      buildContactSourcers(prisma, credentials, 'org-1', DEFAULT_PRIORITY),
    ).rejects.toThrow(/DB unreachable/);
  });
});

/** A CredentialManager stub whose load() rejects with `err`. */
function credentialsThatThrow(err: Error): CredentialManager {
  return {
    load: async () => {
      throw err;
    },
  } as unknown as CredentialManager;
}

describe('buildSourcingProvider — PDL + geo-aware routing', () => {
  const creds = {
    load: async () => ({ apiKey: 'secret', clientId: 'id', clientSecret: 'sec' }),
  } as unknown as CredentialManager;
  const fakePdl: PdlCompanySearcher = {
    searchCompanies: async () => ({ total: 0, records: [] }),
  };
  const fakeZi = (): { searchCompanies: () => Promise<{ data: never[] }> } => ({
    searchCompanies: async () => ({ data: [] }),
  });
  const icp = (locations: string[]): IcpCriteria => ({
    keywords: [],
    employeeCountMin: null,
    employeeCountMax: null,
    fundingStages: [],
    industries: [],
    locations,
  });

  it('builds a PdlSourcingProvider for an explicit pdl source', async () => {
    const prisma = prismaWithKinds(new Set(['pdl']));
    const provider = await buildSourcingProvider(
      prisma, creds, 'org-1', { provider: 'pdl' },
      undefined, undefined, undefined, icp([]), fakePdl,
    );
    expect(provider).toBeInstanceOf(PdlSourcingProvider);
  });

  it('throws a user-fixable error when explicit PDL is not connected', async () => {
    const prisma = prismaWithKinds(new Set());
    await expect(
      buildSourcingProvider(
        prisma, noCreds, 'org-1', { provider: 'pdl' },
        undefined, undefined, undefined, icp([]), fakePdl,
      ),
    ).rejects.toBeInstanceOf(SourcingUnavailableError);
  });

  it('auto-discovery prefers PDL for a city-scoped ICP, even when ZoomInfo is connected', async () => {
    const prisma = prismaWithKinds(new Set(['zoominfo', 'pdl']));
    const provider = await buildSourcingProvider(
      prisma, creds, 'org-1', null,
      undefined, undefined, fakeZi, icp(['Bengaluru']), fakePdl,
    );
    expect(provider).toBeInstanceOf(PdlSourcingProvider);
  });

  it('auto-discovery prefers ZoomInfo for a country-level ICP (cheaper-first)', async () => {
    const prisma = prismaWithKinds(new Set(['zoominfo', 'pdl']));
    const provider = await buildSourcingProvider(
      prisma, creds, 'org-1', null,
      undefined, undefined, fakeZi, icp(['India']), fakePdl,
    );
    expect(provider).toBeInstanceOf(ZoomInfoSourcingProvider);
  });

  it('falls back to PDL in auto-discovery when it is the only source connected', async () => {
    const prisma = prismaWithKinds(new Set(['pdl']));
    const provider = await buildSourcingProvider(
      prisma, creds, 'org-1', null,
      undefined, undefined, fakeZi, icp(['India']), fakePdl,
    );
    expect(provider).toBeInstanceOf(PdlSourcingProvider);
  });
});

describe('buildEnrichmentProvider', () => {
  const stubPdl: PdlCompanyEnricher = { enrichCompany: async () => null };

  it('returns null when PDL is not connected', async () => {
    const prisma = prismaWithKinds(new Set());
    expect(
      await buildEnrichmentProvider(prisma, noCreds, 'org-1', stubPdl),
    ).toBeNull();
  });

  it('builds a PdlEnrichmentProvider when PDL is connected', async () => {
    const prisma = prismaWithKinds(new Set(['pdl']));
    const credentials = {
      load: async () => ({ apiKey: 'secret' }),
    } as unknown as CredentialManager;

    const provider = await buildEnrichmentProvider(
      prisma,
      credentials,
      'org-1',
      stubPdl,
    );
    expect(provider).toBeInstanceOf(PdlEnrichmentProvider);
  });

  it('builds on Cloud too — PDL is not self-host-gated', async () => {
    const prisma = prismaWithKinds(new Set(['pdl']));
    const credentials = {
      load: async () => ({ apiKey: 'secret' }),
    } as unknown as CredentialManager;

    const provider = await buildEnrichmentProvider(
      prisma,
      credentials,
      'org-1',
      stubPdl,
      'cloud',
    );
    expect(provider).toBeInstanceOf(PdlEnrichmentProvider);
  });

  it('returns null (not throw) on a benign credential error — enrichment is best-effort', async () => {
    const prisma = prismaWithKinds(new Set(['pdl']));
    const credentials = credentialsThatThrow(
      new CredentialManagerError('circuit_broken', 'cooldown'),
    );
    expect(
      await buildEnrichmentProvider(prisma, credentials, 'org-1', stubPdl),
    ).toBeNull();
  });

  it('re-throws a non-credential error so the orchestrator can log + skip', async () => {
    const prisma = prismaWithKinds(new Set(['pdl']));
    const credentials = credentialsThatThrow(new Error('DB unreachable'));
    await expect(
      buildEnrichmentProvider(prisma, credentials, 'org-1', stubPdl),
    ).rejects.toThrow(/DB unreachable/);
  });
});
