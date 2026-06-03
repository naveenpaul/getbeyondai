import { describe, expect, it } from 'vitest';
import {
  selectContactTargets,
  type ContactTargetInput,
} from './campaign-orchestrator';

/**
 * Stage 5 gate (eng-review A2): which qualified companies get contacts pulled.
 * Pure function — pulling contacts burns connector credits, so this is the
 * cost-bounding decision and it's worth covering exhaustively.
 */

function cand(over: Partial<ContactTargetInput>): ContactTargetInput {
  return {
    candidateId: over.candidateId ?? 'c1',
    name: over.name ?? 'Acme',
    domain: over.domain ?? 'x.com',
    fitScore: over.fitScore ?? 0.8,
    ...over,
  };
}

describe('selectContactTargets', () => {
  it('includes only qualified companies (fitScore > 0)', () => {
    const result = selectContactTargets(
      [
        cand({ candidateId: 'a', fitScore: 0.9 }),
        cand({ candidateId: 'b', fitScore: 0 }), // not qualified
      ],
      10,
    );
    expect(result.map((t) => t.candidateId)).toEqual(['a']);
  });

  it('excludes companies without a domain (waterfall has no input)', () => {
    const result = selectContactTargets(
      [
        cand({ candidateId: 'a', domain: null }),
        cand({ candidateId: 'b', domain: 'b.com' }),
      ],
      10,
    );
    expect(result).toEqual([{ candidateId: 'b', name: 'Acme', domain: 'b.com' }]);
  });

  it('caps to the top-N (input is already fit-ranked)', () => {
    const result = selectContactTargets(
      [
        cand({ candidateId: 'a' }),
        cand({ candidateId: 'b' }),
        cand({ candidateId: 'c' }),
      ],
      2,
    );
    expect(result.map((t) => t.candidateId)).toEqual(['a', 'b']);
  });

  it('preserves rank order and skips disqualified before counting toward the cap', () => {
    const result = selectContactTargets(
      [
        cand({ candidateId: 'a', fitScore: 0 }), // skipped, doesn't consume a slot
        cand({ candidateId: 'b', fitScore: 0.7 }),
        cand({ candidateId: 'c', fitScore: 0.6 }),
      ],
      2,
    );
    expect(result.map((t) => t.candidateId)).toEqual(['b', 'c']);
  });

  it('returns empty when nothing qualifies', () => {
    expect(selectContactTargets([cand({ fitScore: 0 })], 10)).toEqual([]);
    expect(selectContactTargets([], 10)).toEqual([]);
  });
});
