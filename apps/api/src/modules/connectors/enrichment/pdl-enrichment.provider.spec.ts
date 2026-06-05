import { describe, expect, it, vi } from 'vitest';
import type { DecryptedCredentials } from '@getbeyond/shared';
import type { CandidateCompany } from '../sourcing/sourcing-provider';
import type {
  PdlCompanyEnrichParams,
  PdlCompanyRecord,
} from '../adapters/pdl/pdl.source';
import {
  PdlEnrichmentProvider,
  type PdlCompanyEnricher,
  type VendorHealthReporter,
} from './pdl-enrichment.provider';

const CREDS: DecryptedCredentials = { apiKey: 'k' };

function company(overrides: Partial<CandidateCompany> = {}): CandidateCompany {
  return {
    name: 'Acme Inc',
    domain: null,
    linkedinUrl: null,
    employeeCount: null,
    fundingStage: null,
    raw: {},
    ...overrides,
  };
}

function record(overrides: Partial<PdlCompanyRecord> = {}): PdlCompanyRecord {
  return {
    domain: 'acme.com',
    linkedinUrl: 'https://linkedin.com/company/acme',
    employeeCount: 42,
    industry: 'computer software',
    location: 'san francisco, california, united states',
    raw: { name: 'acme inc', size: '11-50' },
    ...overrides,
  };
}

function stubEnricher(
  result: PdlCompanyRecord | null,
): { adapter: PdlCompanyEnricher; calls: () => [PdlCompanyEnrichParams][] } {
  const fn = vi.fn(async (_params: PdlCompanyEnrichParams) => result);
  return { adapter: { enrichCompany: fn }, calls: () => fn.mock.calls };
}

function noopHealth(): VendorHealthReporter {
  return {
    reportVendorFailure: vi.fn(async () => {}),
    reportVendorSuccess: vi.fn(),
  };
}

describe('PdlEnrichmentProvider', () => {
  it('has the stable name "pdl"', () => {
    const provider = new PdlEnrichmentProvider(
      stubEnricher(null).adapter,
      CREDS,
      'acct',
      noopHealth(),
    );
    expect(provider.name).toBe('pdl');
  });

  it('backfills null firmographics from the PDL record', async () => {
    const provider = new PdlEnrichmentProvider(
      stubEnricher(record()).adapter,
      CREDS,
      'acct',
      noopHealth(),
    );
    const enriched = await provider.enrich(company());
    expect(enriched.domain).toBe('acme.com');
    expect(enriched.linkedinUrl).toBe('https://linkedin.com/company/acme');
    expect(enriched.employeeCount).toBe(42);
    // PDL provenance is folded into raw under the vendor key.
    expect(enriched.raw).toMatchObject({ pdl: { name: 'acme inc', size: '11-50' } });
  });

  it('never overwrites a field the source already filled', async () => {
    const provider = new PdlEnrichmentProvider(
      stubEnricher(record({ employeeCount: 999 })).adapter,
      CREDS,
      'acct',
      noopHealth(),
    );
    const enriched = await provider.enrich(
      company({ domain: null, linkedinUrl: null, employeeCount: 10 }),
    );
    expect(enriched.employeeCount).toBe(10);
  });

  it('does not set funding stage (PDL carries none)', async () => {
    const provider = new PdlEnrichmentProvider(
      stubEnricher(record()).adapter,
      CREDS,
      'acct',
      noopHealth(),
    );
    const enriched = await provider.enrich(company());
    expect(enriched.fundingStage).toBeNull();
  });

  it('passes the company identity + breaker hooks to the adapter', async () => {
    const { adapter, calls } = stubEnricher(record());
    const health = noopHealth();
    const provider = new PdlEnrichmentProvider(adapter, CREDS, 'acct-9', health);
    await provider.enrich(company({ name: 'Beta LLC', domain: 'beta.io', linkedinUrl: 'x' }));
    const arg = calls()[0]?.[0];
    expect(arg).toMatchObject({ creds: CREDS, name: 'Beta LLC', domain: 'beta.io' });

    // Hooks route to the health reporter with this account id.
    await arg?.onVendorFailure?.('server_5xx');
    arg?.onVendorSuccess?.();
    expect(health.reportVendorFailure).toHaveBeenCalledWith('acct-9', 'server_5xx');
    expect(health.reportVendorSuccess).toHaveBeenCalledWith('acct-9');
  });

  it('returns the company unchanged on a no-match (null record)', async () => {
    const provider = new PdlEnrichmentProvider(
      stubEnricher(null).adapter,
      CREDS,
      'acct',
      noopHealth(),
    );
    const input = company();
    const enriched = await provider.enrich(input);
    expect(enriched).toEqual(input);
  });

  it('skips the billable lookup when domain, linkedin, and headcount are all present', async () => {
    const { adapter, calls } = stubEnricher(record());
    const provider = new PdlEnrichmentProvider(adapter, CREDS, 'acct', noopHealth());
    const full = company({
      domain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/company/acme',
      employeeCount: 10,
    });
    const enriched = await provider.enrich(full);
    expect(enriched).toEqual(full);
    expect(calls()).toHaveLength(0);
  });

  it('still calls when one consumed field is missing', async () => {
    const { adapter, calls } = stubEnricher(record());
    const provider = new PdlEnrichmentProvider(adapter, CREDS, 'acct', noopHealth());
    await provider.enrich(
      company({ domain: 'acme.com', linkedinUrl: 'x', employeeCount: null }),
    );
    expect(calls()).toHaveLength(1);
  });

  it('propagates an adapter throw (best-effort policy lives in the orchestrator)', async () => {
    const adapter: PdlCompanyEnricher = {
      enrichCompany: vi.fn(async () => {
        throw new Error('PDL rejected the API key (HTTP 401)');
      }),
    };
    const provider = new PdlEnrichmentProvider(adapter, CREDS, 'acct', noopHealth());
    await expect(provider.enrich(company())).rejects.toThrow(/401/);
  });
});
