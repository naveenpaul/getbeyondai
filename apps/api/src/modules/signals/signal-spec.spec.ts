import { describe, expect, it } from 'vitest';
import { parseSignalSpec, safeParseSignalSpec } from './signal-spec';

describe('parseSignalSpec', () => {
  it('accepts a valid spec of registered signals', () => {
    const spec = parseSignalSpec([
      { key: 'has_problem', weight: 0.5, required: true },
      { key: 'recently_funded', weight: 0.3, params: { withinMonths: 12 } },
    ]);
    expect(spec).toHaveLength(2);
    expect(spec[0]?.required).toBe(true);
    expect(spec[1]?.params).toEqual({ withinMonths: 12 });
  });

  it('accepts an empty spec (neutral — no signal preference)', () => {
    expect(parseSignalSpec([])).toEqual([]);
  });

  it('rejects an unknown signal key', () => {
    const result = safeParseSignalSpec([{ key: 'made_up', weight: 0.5 }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/unknown signal key/);
    }
  });

  it('rejects duplicate keys', () => {
    const result = safeParseSignalSpec([
      { key: 'has_problem', weight: 0.4 },
      { key: 'has_problem', weight: 0.6 },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate/.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects weights outside (0, 1]', () => {
    expect(safeParseSignalSpec([{ key: 'has_problem', weight: 0 }]).success).toBe(
      false,
    );
    expect(
      safeParseSignalSpec([{ key: 'has_problem', weight: 1.5 }]).success,
    ).toBe(false);
    expect(
      safeParseSignalSpec([{ key: 'has_problem', weight: 1 }]).success,
    ).toBe(true);
  });

  it('throws (not returns) on the parse variant', () => {
    expect(() => parseSignalSpec([{ key: 'x', weight: 2 }])).toThrow();
  });
});
