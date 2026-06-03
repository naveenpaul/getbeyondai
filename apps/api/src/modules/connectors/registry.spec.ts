import { describe, expect, it } from 'vitest';
import {
  getSourceAdapter,
  isRegisteredSource,
  listRegisteredSources,
  UnknownConnectorError,
} from './registry';
import { csvSourceAdapter } from './adapters/csv.source';
import { hubspotSourceAdapter } from './adapters/hubspot.source';
import { apolloSourceAdapter } from './adapters/apollo/apollo.source';

describe('source-adapter registry', () => {
  it('returns the CSV adapter for kind=csv', () => {
    expect(getSourceAdapter('csv')).toBe(csvSourceAdapter);
  });

  it('returns the HubSpot adapter for kind=hubspot', () => {
    expect(getSourceAdapter('hubspot')).toBe(hubspotSourceAdapter);
  });

  it('returns the Apollo adapter for kind=apollo', () => {
    expect(getSourceAdapter('apollo')).toBe(apolloSourceAdapter);
  });

  it('throws UnknownConnectorError for kinds not yet registered', () => {
    for (const kind of ['salesforce'] as const) {
      try {
        getSourceAdapter(kind);
        expect.fail(`should have thrown for ${kind}`);
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownConnectorError);
        expect((err as UnknownConnectorError).kind).toBe(kind);
      }
    }
  });

  it('UnknownConnectorError message names the missing kind', () => {
    try {
      getSourceAdapter('salesforce');
    } catch (err) {
      expect((err as Error).message).toContain('salesforce');
    }
  });

  it('isRegisteredSource reflects registry state', () => {
    expect(isRegisteredSource('csv')).toBe(true);
    expect(isRegisteredSource('hubspot')).toBe(true);
    expect(isRegisteredSource('apollo')).toBe(true);
    expect(isRegisteredSource('snov')).toBe(true);
    expect(isRegisteredSource('zoominfo')).toBe(true);
    expect(isRegisteredSource('salesforce')).toBe(false);
  });

  it('listRegisteredSources returns only the connectors that are wired', () => {
    expect(listRegisteredSources().sort()).toEqual([
      'apollo',
      'csv',
      'hubspot',
      'snov',
      'zoominfo',
    ]);
  });
});
