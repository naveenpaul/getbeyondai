import { describe, expect, it } from 'vitest';
import type { CandidateCompany } from '../sourcing/sourcing-provider';
import { mergeEnrichment } from './enrichment-provider';

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

describe('mergeEnrichment', () => {
  it('fills null fields from the patch', () => {
    const merged = mergeEnrichment(company(), {
      domain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/company/acme',
      employeeCount: 42,
      fundingStage: 'seed',
    });
    expect(merged).toMatchObject({
      domain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/company/acme',
      employeeCount: 42,
      fundingStage: 'seed',
    });
  });

  it('never overwrites a non-null field the source already returned', () => {
    const base = company({
      domain: 'real.com',
      employeeCount: 10,
      fundingStage: 'series_a',
    });
    const merged = mergeEnrichment(base, {
      domain: 'wrong.com',
      employeeCount: 999,
      fundingStage: 'seed',
    });
    expect(merged.domain).toBe('real.com');
    expect(merged.employeeCount).toBe(10);
    expect(merged.fundingStage).toBe('series_a');
  });

  it('leaves a field null when neither base nor patch has it', () => {
    const merged = mergeEnrichment(company(), { domain: 'acme.com' });
    expect(merged.linkedinUrl).toBeNull();
    expect(merged.employeeCount).toBeNull();
    expect(merged.fundingStage).toBeNull();
  });

  it('treats employeeCount 0 as a present value (no overwrite)', () => {
    const merged = mergeEnrichment(company({ employeeCount: 0 }), {
      employeeCount: 50,
    });
    expect(merged.employeeCount).toBe(0);
  });

  it('shallow-merges raw provenance under the patch keys', () => {
    const base = company({ raw: { apollo: { id: 'a1' } } });
    const merged = mergeEnrichment(base, { raw: { pdl: { size: '11-50' } } });
    expect(merged.raw).toEqual({ apollo: { id: 'a1' }, pdl: { size: '11-50' } });
  });

  it('leaves raw untouched when the patch carries none', () => {
    const base = company({ raw: { apollo: { id: 'a1' } } });
    const merged = mergeEnrichment(base, { domain: 'acme.com' });
    expect(merged.raw).toEqual({ apollo: { id: 'a1' } });
  });

  it('does not mutate the base candidate', () => {
    const base = company();
    mergeEnrichment(base, { domain: 'acme.com' });
    expect(base.domain).toBeNull();
  });
});
