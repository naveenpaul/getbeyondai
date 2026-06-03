import { describe, expect, it } from 'vitest';
import {
  UnknownSignalError,
  getSignalDefinition,
  isKnownSignal,
  listSignalDefinitions,
  signalsByCategory,
} from './signal-definition';

describe('signal registry', () => {
  it('exposes a non-empty catalog with unique keys', () => {
    const defs = listSignalDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    const keys = defs.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers all three signal categories', () => {
    expect(signalsByCategory('fit').length).toBeGreaterThan(0);
    expect(signalsByCategory('timing').length).toBeGreaterThan(0);
    expect(signalsByCategory('reachability').length).toBeGreaterThan(0);
  });

  it('looks up a known signal by key', () => {
    const def = getSignalDefinition('recently_funded');
    expect(def.category).toBe('timing');
    expect(def.decayDays).toBe(180);
    expect(def.acquisition).toEqual({
      kind: 'connector_filter',
      param: 'fundingDateWithinMonths',
    });
  });

  it('throws UnknownSignalError for an unregistered key', () => {
    expect(() => getSignalDefinition('does_not_exist')).toThrow(
      UnknownSignalError,
    );
  });

  it('isKnownSignal reflects registry membership', () => {
    expect(isKnownSignal('has_problem')).toBe(true);
    expect(isKnownSignal('nope')).toBe(false);
  });

  it('fit signals never decay; the reachability signal is computed', () => {
    expect(getSignalDefinition('has_problem').decayDays).toBeUndefined();
    expect(getSignalDefinition('reachable_decision_maker').acquisition).toEqual({
      kind: 'computed',
      from: 'contact_waterfall',
    });
  });
});
