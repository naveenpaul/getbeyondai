import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { ContactListSourcingProvider } from '../connectors/sourcing/contact-list-sourcing.provider';
import { buildSourcingProvider } from './campaign.worker';

/**
 * Unit tests for the worker's `buildSourcingProvider` factory. The worker class
 * itself (pg-boss registration + DI wiring) is integration-tested; here we cover
 * the pure provider-selection branch. Explicit vitest imports — `globals: false`.
 */

const prisma = {} as unknown as PrismaService;

describe('buildSourcingProvider', () => {
  it('builds a ContactListSourcingProvider for the contact_list provider', () => {
    const provider = buildSourcingProvider(prisma, 'org-1', {
      provider: 'contact_list',
      listId: 'list-1',
    });
    expect(provider).toBeInstanceOf(ContactListSourcingProvider);
  });

  it('throws a clear "not configured" error for the reserved apollo provider', () => {
    expect(() =>
      buildSourcingProvider(prisma, 'org-1', {
        provider: 'apollo',
        reserved: true,
      }),
    ).toThrow(/not configured/i);
  });
});
