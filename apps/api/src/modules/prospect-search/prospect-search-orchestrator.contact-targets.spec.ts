import { describe, expect, it } from 'vitest';
import {
  selectContactTargets,
  type ContactTargetInput,
} from './prospect-search-orchestrator';

/**
 * Stage 5 gate (eng-review A2): which qualified companies get contacts pulled.
 * Pure function — pulling contacts burns connector credits, so this is the
 * cost-bounding decision and it's worth covering exhaustively.
 */

function cand(over: Partial<ContactTargetInput>): ContactTargetInput {
  return {
    prospectId: over.prospectId ?? 'c1',
    name: over.name ?? 'Acme',
    domain: over.domain ?? 'x.com',
    fitScore: over.fitScore ?? 0.8,
    ...over,
  };
}

describe('selectContactTargets', () => {
  it('includes only companies at/above the default fit threshold (0.6)', () => {
    const result = selectContactTargets(
      [
        cand({ prospectId: 'a', fitScore: 0.9 }), // clears the bar
        cand({ prospectId: 'b', fitScore: 0.5 }), // weak match — excluded
        cand({ prospectId: 'c', fitScore: 0 }), // not qualified — excluded
      ],
      10,
    );
    expect(result.map((t) => t.prospectId)).toEqual(['a']);
  });

  it('includes a company exactly at the threshold (>=)', () => {
    const result = selectContactTargets([cand({ fitScore: 0.6 })], 10);
    expect(result).toHaveLength(1);
  });

  it('honors an explicit minFitScore override', () => {
    const ranked = [
      cand({ prospectId: 'a', fitScore: 0.55 }),
      cand({ prospectId: 'b', fitScore: 0.3 }),
    ];
    // Lower the bar to 0.5 → only `a` qualifies.
    expect(selectContactTargets(ranked, 10, 0.5).map((t) => t.prospectId)).toEqual([
      'a',
    ]);
    // Raise it to 0.9 → none qualify.
    expect(selectContactTargets(ranked, 10, 0.9)).toEqual([]);
  });

  it('excludes companies without a domain (waterfall has no input)', () => {
    const result = selectContactTargets(
      [
        cand({ prospectId: 'a', domain: null }),
        cand({ prospectId: 'b', domain: 'b.com' }),
      ],
      10,
    );
    expect(result).toEqual([{ prospectId: 'b', name: 'Acme', domain: 'b.com' }]);
  });

  it('caps to the top-N (input is already fit-ranked)', () => {
    const result = selectContactTargets(
      [
        cand({ prospectId: 'a' }),
        cand({ prospectId: 'b' }),
        cand({ prospectId: 'c' }),
      ],
      2,
    );
    expect(result.map((t) => t.prospectId)).toEqual(['a', 'b']);
  });

  it('preserves rank order and skips disqualified before counting toward the cap', () => {
    const result = selectContactTargets(
      [
        cand({ prospectId: 'a', fitScore: 0 }), // skipped, doesn't consume a slot
        cand({ prospectId: 'b', fitScore: 0.7 }),
        cand({ prospectId: 'c', fitScore: 0.6 }),
      ],
      2,
    );
    expect(result.map((t) => t.prospectId)).toEqual(['b', 'c']);
  });

  it('returns empty when nothing qualifies', () => {
    expect(selectContactTargets([cand({ fitScore: 0 })], 10)).toEqual([]);
    expect(selectContactTargets([], 10)).toEqual([]);
  });
});
