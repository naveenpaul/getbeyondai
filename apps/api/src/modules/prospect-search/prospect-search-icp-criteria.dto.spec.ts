import { describe, expect, it } from 'vitest';
import { CreateProspectSearchRequestSchema } from './prospect-search.dto';

/** Validation of the optional explicit-ICP-criteria field on the create body. */
describe('CreateProspectSearchRequestSchema — icpCriteria', () => {
  it('accepts a request with no icpCriteria (derive-only)', () => {
    const parsed = CreateProspectSearchRequestSchema.safeParse({
      goal: 'find lookalikes of my best customers',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts explicit null (cleared)', () => {
    const parsed = CreateProspectSearchRequestSchema.safeParse({
      goal: 'g',
      icpCriteria: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a partial criteria object', () => {
    const parsed = CreateProspectSearchRequestSchema.safeParse({
      goal: 'g',
      icpCriteria: {
        industries: ['Healthcare'],
        employeeCountMin: 50,
        employeeCountMax: null,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative employee count', () => {
    const parsed = CreateProspectSearchRequestSchema.safeParse({
      goal: 'g',
      icpCriteria: { employeeCountMin: -5 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer employee count', () => {
    const parsed = CreateProspectSearchRequestSchema.safeParse({
      goal: 'g',
      icpCriteria: { employeeCountMax: 12.5 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty-string keyword', () => {
    const parsed = CreateProspectSearchRequestSchema.safeParse({
      goal: 'g',
      icpCriteria: { keywords: [''] },
    });
    expect(parsed.success).toBe(false);
  });
});
