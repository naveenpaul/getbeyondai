import { describe, expect, it, vi } from 'vitest';
import type {
  ApolloOrganization,
  ApolloOrgSearchParams,
} from '../adapters/apollo/apollo.source';
import type { DecryptedCredentials } from '@getbeyond/shared';
import {
  ApolloSourcingProvider,
  icpToApolloOrgCriteria,
  type ApolloOrgSearcher,
  type VendorHealthReporter,
} from './apollo-sourcing.provider';
import { SourcingUnavailableError } from './sourcing-provider';
import type { IcpCriteria } from './sourcing-provider';

/**
 * Unit tests for the Apollo company-discovery sourcing provider. The vendor HTTP
 * lives in the adapter (separately tested); here we stub `searchOrganizations`
 * to cover ICP→criteria mapping, dedupe, limit, summary, and breaker wiring.
 * Explicit vitest imports — `globals: false`.
 */

const CREDS: DecryptedCredentials = { apiKey: 'k' };

function icp(overrides: Partial<IcpCriteria> = {}): IcpCriteria {
  return {
    keywords: [],
    employeeCountMin: null,
    employeeCountMax: null,
    fundingStages: [],
    industries: [],
    locations: [],
    ...overrides,
  };
}

function org(overrides: Partial<ApolloOrganization> = {}): ApolloOrganization {
  return {
    externalId: 'o1',
    name: 'Acme Inc',
    domain: 'acme.com',
    linkedinUrl: null,
    employeeCount: 42,
    fundingStage: 'Seed',
    raw: {},
    ...overrides,
  };
}

/** An adapter stub that yields the given orgs and records the params it got. */
function stubAdapter(orgs: ApolloOrganization[]): {
  adapter: ApolloOrgSearcher;
  lastParams: () => ApolloOrgSearchParams | undefined;
} {
  let captured: ApolloOrgSearchParams | undefined;
  const adapter: ApolloOrgSearcher = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *searchOrganizations(params) {
      captured = params;
      for (const o of orgs) yield o;
    },
  };
  return { adapter, lastParams: () => captured };
}

function noopHealth(): VendorHealthReporter {
  return {
    reportVendorFailure: vi.fn(async () => {}),
    reportVendorSuccess: vi.fn(),
  };
}

describe('icpToApolloOrgCriteria', () => {
  it('maps populated ICP fields to Apollo org criteria', () => {
    const criteria = icpToApolloOrgCriteria(
      icp({
        keywords: ['devtools'],
        industries: ['software'],
        fundingStages: ['seed'],
        locations: ['US'],
        employeeCountMin: 1,
        employeeCountMax: 10,
      }),
    );
    expect(criteria).toEqual({
      keywords: ['devtools'],
      industries: ['software'],
      fundingStages: ['seed'],
      locations: ['US'],
      companyHeadcount: { min: 1, max: 10 },
    });
  });

  it('omits empty fields and headcount when both bounds are null', () => {
    expect(icpToApolloOrgCriteria(icp())).toEqual({});
  });

  it('includes a one-sided headcount range', () => {
    const criteria = icpToApolloOrgCriteria(icp({ employeeCountMax: 50 }));
    expect(criteria.companyHeadcount).toEqual({ min: undefined, max: 50 });
  });
});

describe('ApolloSourcingProvider.findCandidates', () => {
  it('returns discovered companies as candidates', async () => {
    const { adapter } = stubAdapter([org()]);
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(icp());
    expect(result.candidates).toEqual([
      {
        name: 'Acme Inc',
        domain: 'acme.com',
        linkedinUrl: null,
        employeeCount: 42,
        fundingStage: 'Seed',
        raw: {},
      },
    ]);
  });

  it('dedupes by domain (falling back to name)', async () => {
    const { adapter } = stubAdapter([
      org({ externalId: 'a', domain: 'acme.com' }),
      org({ externalId: 'b', domain: 'acme.com', name: 'Acme (dup)' }),
      org({ externalId: 'c', domain: null, name: 'Beta' }),
    ]);
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(icp());
    expect(result.candidates.map((c) => c.name)).toEqual(['Acme Inc', 'Beta']);
  });

  it('honors the limit and passes maxOrgs to the adapter', async () => {
    const { adapter, lastParams } = stubAdapter([
      org({ externalId: 'a', domain: 'a.com' }),
      org({ externalId: 'b', domain: 'b.com' }),
      org({ externalId: 'c', domain: 'c.com' }),
    ]);
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(icp(), { limit: 2 });
    expect(result.candidates).toHaveLength(2);
    expect(lastParams()?.config.maxOrgs).toBe(2);
  });

  it('wires the breaker hooks to the health reporter with the account id', async () => {
    const { adapter, lastParams } = stubAdapter([]);
    const health = noopHealth();
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct-9', health);
    await provider.findCandidates(icp());

    await lastParams()?.onVendorFailure?.('server_5xx');
    lastParams()?.onVendorSuccess?.();
    expect(health.reportVendorFailure).toHaveBeenCalledWith('acct-9', 'server_5xx');
    expect(health.reportVendorSuccess).toHaveBeenCalledWith('acct-9');
  });

  it('maps a key rejection mid-search to a graceful SourcingUnavailableError', async () => {
    // The adapter reports an auth failure via the breaker hook, then throws —
    // exactly the live 401 path. The provider must convert it to the graceful
    // "reconnect" signal, not let a raw error fail the whole search.
    const adapter: ApolloOrgSearcher = {
      async *searchOrganizations(params) {
        await params.onVendorFailure?.('auth_invalid');
        throw new Error('Apollo rejected the API key (HTTP 401)');
      },
    };
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    await expect(provider.findCandidates(icp())).rejects.toBeInstanceOf(
      SourcingUnavailableError,
    );
  });

  it('rethrows a non-auth error (5xx/transport) so pg-boss can retry', async () => {
    const adapter: ApolloOrgSearcher = {
      async *searchOrganizations(params) {
        await params.onVendorFailure?.('server_5xx');
        throw new Error('Apollo server error (HTTP 503)');
      },
    };
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    await expect(provider.findCandidates(icp())).rejects.toThrow(/503/);
  });

  it('summarizes a zero-result search', async () => {
    const { adapter } = stubAdapter([]);
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(icp());
    expect(result.candidates).toHaveLength(0);
    expect(result.summary).toMatch(/no companies/i);
  });

  it('summarizes results with headcount + location facets', async () => {
    const { adapter } = stubAdapter([org()]);
    const provider = new ApolloSourcingProvider(adapter, CREDS, 'acct', noopHealth());
    const result = await provider.findCandidates(
      icp({ employeeCountMin: 1, employeeCountMax: 10, locations: ['US'] }),
    );
    expect(result.summary).toContain('Apollo: 1 company');
    expect(result.summary).toContain('1-10 employees');
    expect(result.summary).toContain('US');
  });
});
