import { describe, expect, it } from 'vitest';
import type { IcpCriteria } from '../connectors/sourcing/sourcing-provider';
import { mergeIcp } from './prospect-search-orchestrator';
import { buildIcpDerivationUserPrompt } from './prospect-search.prompts';

/** A fully-populated derived ICP to override against. */
const DERIVED: IcpCriteria = {
  keywords: ['fintech', 'payments'],
  employeeCountMin: 10,
  employeeCountMax: 200,
  fundingStages: ['seed', 'series_a'],
  industries: ['Financial Services'],
  locations: ['North America'],
};

describe('mergeIcp', () => {
  it('returns the derived ICP unchanged when no override is given', () => {
    expect(mergeIcp(DERIVED)).toEqual(DERIVED);
    expect(mergeIcp(DERIVED, null)).toEqual(DERIVED);
    expect(mergeIcp(DERIVED, undefined)).toEqual(DERIVED);
  });

  it('overrides only the fields the user provided (field-by-field)', () => {
    const merged = mergeIcp(DERIVED, { industries: ['Healthcare'] });
    expect(merged.industries).toEqual(['Healthcare']);
    // Untouched fields keep the derived values.
    expect(merged.keywords).toEqual(DERIVED.keywords);
    expect(merged.employeeCountMax).toBe(DERIVED.employeeCountMax);
    expect(merged.fundingStages).toEqual(DERIVED.fundingStages);
    expect(merged.locations).toEqual(DERIVED.locations);
  });

  it('treats an explicit null employee-count bound as "clear it", not "not provided"', () => {
    const merged = mergeIcp(DERIVED, { employeeCountMax: null });
    expect(merged.employeeCountMax).toBeNull();
    // The min bound (not in the override) is untouched.
    expect(merged.employeeCountMin).toBe(DERIVED.employeeCountMin);
  });

  it('keeps an explicit 0 bound (not treated as falsy/absent)', () => {
    const merged = mergeIcp(DERIVED, { employeeCountMin: 0 });
    expect(merged.employeeCountMin).toBe(0);
  });

  it('lets an explicit empty array override a derived non-empty array', () => {
    const merged = mergeIcp(DERIVED, { fundingStages: [] });
    expect(merged.fundingStages).toEqual([]);
  });

  it('applies a multi-field override at once', () => {
    const merged = mergeIcp(DERIVED, {
      keywords: ['logistics'],
      employeeCountMin: 50,
      employeeCountMax: 500,
      locations: ['Europe'],
    });
    expect(merged).toEqual({
      keywords: ['logistics'],
      employeeCountMin: 50,
      employeeCountMax: 500,
      fundingStages: DERIVED.fundingStages,
      industries: DERIVED.industries,
      locations: ['Europe'],
    });
  });

  it('does not mutate the inputs', () => {
    const derived = { ...DERIVED, keywords: [...DERIVED.keywords] };
    mergeIcp(derived, { keywords: ['x'] });
    expect(derived.keywords).toEqual(DERIVED.keywords);
  });
});

describe('buildIcpDerivationUserPrompt — explicit constraints', () => {
  it('omits the constraints block entirely when no criteria are given', () => {
    const prompt = buildIcpDerivationUserPrompt('find lookalikes', []);
    expect(prompt).not.toContain('HARD ICP constraints');
  });

  it('omits the block when criteria are present but all empty', () => {
    const prompt = buildIcpDerivationUserPrompt('goal', [], {
      keywords: [],
      industries: [],
    });
    expect(prompt).not.toContain('HARD ICP constraints');
  });

  it('renders provided constraints so the model honors them in the summary', () => {
    const prompt = buildIcpDerivationUserPrompt('goal', [], {
      industries: ['Healthcare', 'Biotech'],
      employeeCountMin: 50,
      employeeCountMax: 500,
    });
    expect(prompt).toContain('HARD ICP constraints');
    expect(prompt).toContain('Industries: Healthcare, Biotech');
    expect(prompt).toContain('Employee count: 50–500');
  });

  it('renders an open-ended employee bound as "any"', () => {
    const prompt = buildIcpDerivationUserPrompt('goal', [], {
      employeeCountMin: 100,
    });
    expect(prompt).toContain('Employee count: 100–any');
  });
});
