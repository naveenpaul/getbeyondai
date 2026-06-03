import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  CredentialManager,
  CredentialManagerError,
} from '../connectors/credential-manager';
import { ApolloSourcingProvider } from '../connectors/sourcing/apollo-sourcing.provider';
import { ContactListSourcingProvider } from '../connectors/sourcing/contact-list-sourcing.provider';
import { SourcingUnavailableError } from '../connectors/sourcing/sourcing-provider';
import { buildContactSourcers, buildSourcingProvider } from './prospect-search.worker';

/**
 * Unit tests for the worker's `buildSourcingProvider` factory. The worker class
 * itself (pg-boss registration + DI wiring) is integration-tested; here we cover
 * the provider-selection branches with stubbed prisma + CredentialManager.
 * Explicit vitest imports — `globals: false`.
 */

const emptyPrisma = {} as unknown as PrismaService;
const noCreds = {} as unknown as CredentialManager;

/** A prisma stub whose connectorAccount.findUnique returns `account`. */
function prismaWithApolloAccount(
  account: { id: string } | null,
): PrismaService {
  return {
    connectorAccount: {
      findUnique: async () => account,
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

  it('returns no connectors when none are connected', async () => {
    const prisma = prismaWithConnectorKinds(new Set());
    expect(await buildContactSourcers(prisma, creds, 'org-1')).toEqual([]);
  });

  it('builds a bound Snov WaterfallConnector when only Snov is connected', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov']));
    const connectors = await buildContactSourcers(prisma, creds, 'org-1');
    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.kind).toBe('snov');
    expect(connectors[0]!.accountId).toBe('acct-snov');
  });

  it('orders ZoomInfo before Snov when both are connected', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov', 'zoominfo']));
    const connectors = await buildContactSourcers(prisma, creds, 'org-1');
    expect(connectors.map((c) => c.kind)).toEqual(['zoominfo', 'snov']);
  });

  it('skips a connector whose credentials are rejected (best-effort, never fails)', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov']));
    const credentials = credentialsThatThrow(
      new CredentialManagerError('expired', 'key rejected'),
    );
    expect(await buildContactSourcers(prisma, credentials, 'org-1')).toEqual([]);
  });

  it('re-throws a non-credential error so pg-boss can retry', async () => {
    const prisma = prismaWithConnectorKinds(new Set(['snov']));
    const credentials = credentialsThatThrow(new Error('DB unreachable'));
    await expect(
      buildContactSourcers(prisma, credentials, 'org-1'),
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
