import { describe, expect, it } from 'vitest';
import {
  InvalidSignalObservationError,
  type SignalObservation,
  validateSignalObservation,
} from './company-signal.repository';

const base: SignalObservation = {
  candidateId: 'cand-1',
  key: 'has_problem',
  status: 'present',
  source: 'research',
  citationId: 'cit-1',
};

describe('validateSignalObservation', () => {
  it('accepts a present research signal that carries a citation', () => {
    expect(() => validateSignalObservation(base)).not.toThrow();
  });

  it('rejects an unregistered signal key', () => {
    expect(() =>
      validateSignalObservation({ ...base, key: 'made_up' }),
    ).toThrow(InvalidSignalObservationError);
  });

  it('rejects a present research signal with no citation (cite-or-abstain)', () => {
    expect(() =>
      validateSignalObservation({ ...base, citationId: null }),
    ).toThrow(/cite-or-abstain/);
  });

  it('allows a present CONNECTOR signal without a citation', () => {
    expect(() =>
      validateSignalObservation({
        candidateId: 'c',
        key: 'recently_funded',
        status: 'present',
        source: 'connector',
      }),
    ).not.toThrow();
  });

  it('allows a present COMPUTED signal (reachability) without a citation', () => {
    expect(() =>
      validateSignalObservation({
        candidateId: 'c',
        key: 'reachable_decision_maker',
        status: 'present',
        source: 'computed',
      }),
    ).not.toThrow();
  });

  it('allows an ABSENT research signal without a citation (nothing asserted)', () => {
    expect(() =>
      validateSignalObservation({
        candidateId: 'c',
        key: 'has_problem',
        status: 'absent',
        source: 'research',
      }),
    ).not.toThrow();
  });
});
