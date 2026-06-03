import { describe, expect, it } from 'vitest';
import { getSignalDefinition } from './signal-definition';
import {
  type SignalObservationView,
  isFresh,
  scoreCandidate,
} from './signal-scoring';
import type { SignalSpec } from './signal-spec';

const NOW = new Date('2026-06-03T00:00:00Z');
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('isFresh', () => {
  const funded = getSignalDefinition('recently_funded'); // decayDays 180
  const hasProblem = getSignalDefinition('has_problem'); // no decay

  it('a non-decaying signal is fresh whenever present', () => {
    expect(isFresh(hasProblem, { status: 'present', detectedAt: daysAgo(999) }, NOW)).toBe(true);
    expect(isFresh(hasProblem, { status: 'present', detectedAt: null }, NOW)).toBe(true);
  });

  it('a decaying signal is fresh within the window, stale past it', () => {
    expect(isFresh(funded, { status: 'present', detectedAt: daysAgo(30) }, NOW)).toBe(true);
    expect(isFresh(funded, { status: 'present', detectedAt: daysAgo(200) }, NOW)).toBe(false);
  });

  it('a present decaying signal with no detectedAt is treated as stale', () => {
    expect(isFresh(funded, { status: 'present', detectedAt: null }, NOW)).toBe(false);
  });

  it('absent / unknown are never fresh', () => {
    expect(isFresh(hasProblem, { status: 'absent', detectedAt: null }, NOW)).toBe(false);
    expect(isFresh(funded, { status: 'unknown', detectedAt: daysAgo(1) }, NOW)).toBe(false);
  });

  it('future-dated detections (clock skew) count as fresh', () => {
    expect(isFresh(funded, { status: 'present', detectedAt: daysAgo(-5) }, NOW)).toBe(true);
  });
});

describe('scoreCandidate', () => {
  const obs = (
    key: string,
    status: SignalObservationView['status'],
    detectedAt: Date | null = null,
  ): SignalObservationView => ({ key, status, detectedAt });

  it('an empty spec scores 1.0 and never disqualifies', () => {
    const result = scoreCandidate([obs('has_problem', 'present')], [], NOW);
    expect(result).toEqual({ score: 1, disqualified: false, breakdown: [] });
  });

  it('normalizes contribution by total weight', () => {
    const spec: SignalSpec = [
      { key: 'has_problem', weight: 0.5 },
      { key: 'recently_funded', weight: 0.5 },
    ];
    // has_problem present (fresh, no decay); recently_funded absent → 0.5 / 1.0
    const result = scoreCandidate(
      [obs('has_problem', 'present'), obs('recently_funded', 'absent')],
      spec,
      NOW,
    );
    expect(result.score).toBeCloseTo(0.5);
    expect(result.disqualified).toBe(false);
  });

  it('a stale timing signal contributes 0 (act-NOW enforcement)', () => {
    const spec: SignalSpec = [{ key: 'recently_funded', weight: 1 }];
    const fresh = scoreCandidate(
      [obs('recently_funded', 'present', daysAgo(30))],
      spec,
      NOW,
    );
    const stale = scoreCandidate(
      [obs('recently_funded', 'present', daysAgo(400))],
      spec,
      NOW,
    );
    expect(fresh.score).toBe(1);
    expect(stale.score).toBe(0);
  });

  it('a required signal not present+fresh disqualifies regardless of score', () => {
    const spec: SignalSpec = [
      { key: 'has_problem', weight: 0.5, required: true },
      { key: 'recently_funded', weight: 0.5 },
    ];
    const result = scoreCandidate(
      [obs('has_problem', 'absent'), obs('recently_funded', 'present', daysAgo(1))],
      spec,
      NOW,
    );
    expect(result.disqualified).toBe(true);
    // still reports the numeric contribution of the non-required signal
    expect(result.score).toBeCloseTo(0.5);
  });

  it('reports a per-signal breakdown', () => {
    const spec: SignalSpec = [{ key: 'has_problem', weight: 1, required: true }];
    const result = scoreCandidate([obs('has_problem', 'present')], spec, NOW);
    expect(result.breakdown).toEqual([
      {
        key: 'has_problem',
        status: 'present',
        fresh: true,
        weight: 1,
        contribution: 1,
        disqualifies: false,
      },
    ]);
  });

  it('treats a signal with no observation as unknown / absent', () => {
    const spec: SignalSpec = [{ key: 'hiring_for_role', weight: 1 }];
    const result = scoreCandidate([], spec, NOW);
    expect(result.score).toBe(0);
    expect(result.breakdown[0]?.status).toBe('unknown');
  });
});
