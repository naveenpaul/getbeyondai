import { describe, expect, it } from 'vitest';
import {
  assertWithinBudget,
  BudgetExceededError,
  costCentsForCall,
  MODEL_PRICING,
  UnknownModelError,
} from './cost';

describe('costCentsForCall', () => {
  it('charges sonnet-4-6 at $3/$15 per million (input/output)', () => {
    // 1M input tokens @ $3 = 300 cents; 1M output @ $15 = 1500 cents.
    expect(
      costCentsForCall('claude-sonnet-4-6', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(1800);
  });

  it('charges opus-4-7 at $15/$75 per million', () => {
    expect(
      costCentsForCall('claude-opus-4-7', {
        inputTokens: 100_000,
        outputTokens: 10_000,
      }),
    ).toBe(Math.ceil((100_000 * 15) / 10_000 + (10_000 * 75) / 10_000));
  });

  it('charges haiku-4-5 at $0.80/$4 per million', () => {
    expect(
      costCentsForCall('claude-haiku-4-5-20251001', {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(80);
  });

  it('rounds sub-cent calls UP (avoid silent under-billing)', () => {
    // sonnet 100 input tokens = 0.03 cents → rounds to 1.
    expect(
      costCentsForCall('claude-sonnet-4-6', {
        inputTokens: 100,
        outputTokens: 0,
      }),
    ).toBe(1);
  });

  it('returns 0 only for genuinely zero-token calls', () => {
    expect(
      costCentsForCall('claude-sonnet-4-6', {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it('throws UnknownModelError for unrecognized model names', () => {
    try {
      costCentsForCall('claude-fictional-99', {
        inputTokens: 100,
        outputTokens: 100,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelError);
      expect((err as UnknownModelError).modelName).toBe('claude-fictional-99');
    }
  });

  it('rejects negative token counts', () => {
    expect(() =>
      costCentsForCall('claude-sonnet-4-6', {
        inputTokens: -1,
        outputTokens: 100,
      }),
    ).toThrow(RangeError);
    expect(() =>
      costCentsForCall('claude-sonnet-4-6', {
        inputTokens: 100,
        outputTokens: -1,
      }),
    ).toThrow(RangeError);
  });

  it('UnknownModelError message names the missing model', () => {
    try {
      costCentsForCall('typo-model', { inputTokens: 1, outputTokens: 1 });
    } catch (err) {
      expect((err as Error).message).toContain('typo-model');
      expect((err as Error).message).toContain('MODEL_PRICING');
    }
  });

  it('MODEL_PRICING covers the three v1 models', () => {
    expect(MODEL_PRICING).toHaveProperty('claude-opus-4-7');
    expect(MODEL_PRICING).toHaveProperty('claude-sonnet-4-6');
    expect(MODEL_PRICING).toHaveProperty('claude-haiku-4-5-20251001');
  });
});

describe('assertWithinBudget', () => {
  it('passes when current + proposed is strictly below the cap', () => {
    expect(() => assertWithinBudget(50, 20, 100)).not.toThrow();
  });

  it('passes when current + proposed exactly equals the cap', () => {
    expect(() => assertWithinBudget(80, 20, 100)).not.toThrow();
  });

  it('throws BudgetExceededError when current + proposed exceeds the cap', () => {
    try {
      assertWithinBudget(80, 21, 100);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const e = err as BudgetExceededError;
      expect(e.currentCents).toBe(80);
      expect(e.proposedCents).toBe(21);
      expect(e.budgetCents).toBe(100);
    }
  });

  it('error message includes all three values for the audit trail', () => {
    try {
      assertWithinBudget(80, 21, 100);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('80');
      expect(msg).toContain('21');
      expect(msg).toContain('100');
    }
  });

  it('treats a current of 0 + over-budget single call as a violation', () => {
    expect(() => assertWithinBudget(0, 150, 100)).toThrow(BudgetExceededError);
  });
});
