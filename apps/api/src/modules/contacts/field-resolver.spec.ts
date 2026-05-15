import { describe, expect, it } from 'vitest';
import {
  type FieldProvenance,
  resolveFieldUpdates,
  tierFromConnectorKind,
  TIER_PRECEDENCE,
} from './field-resolver';

const T0 = new Date('2026-05-15T10:00:00.000Z');
const T1 = new Date('2026-05-15T11:00:00.000Z');
const T2 = new Date('2026-05-15T12:00:00.000Z');

describe('TIER_PRECEDENCE — eng-review D3 ladder', () => {
  it('manual is the highest tier (never overwritten by vendor sync)', () => {
    expect(TIER_PRECEDENCE.manual).toBeGreaterThan(TIER_PRECEDENCE.hubspot);
    expect(TIER_PRECEDENCE.manual).toBeGreaterThan(TIER_PRECEDENCE.salesforce);
    expect(TIER_PRECEDENCE.manual).toBeGreaterThan(TIER_PRECEDENCE.apollo);
    expect(TIER_PRECEDENCE.manual).toBeGreaterThan(TIER_PRECEDENCE.zoominfo);
    expect(TIER_PRECEDENCE.manual).toBeGreaterThan(TIER_PRECEDENCE.csv);
  });

  it('CRM tier (HubSpot/Salesforce) sits above vendor enrichment', () => {
    expect(TIER_PRECEDENCE.hubspot).toBe(TIER_PRECEDENCE.salesforce);
    expect(TIER_PRECEDENCE.hubspot).toBeGreaterThan(TIER_PRECEDENCE.apollo);
    expect(TIER_PRECEDENCE.salesforce).toBeGreaterThan(TIER_PRECEDENCE.zoominfo);
  });

  it('Apollo + ZoomInfo at the same vendor-enrichment tier', () => {
    expect(TIER_PRECEDENCE.apollo).toBe(TIER_PRECEDENCE.zoominfo);
  });

  it('CSV is the lowest tier (user-supplied but unverified)', () => {
    expect(TIER_PRECEDENCE.csv).toBeLessThan(TIER_PRECEDENCE.apollo);
    expect(TIER_PRECEDENCE.csv).toBeLessThan(TIER_PRECEDENCE.hubspot);
  });
});

describe('resolveFieldUpdates — new fields (no existing provenance)', () => {
  it('writes incoming values when no prior provenance exists', () => {
    const result = resolveFieldUpdates({
      existingProvenance: {},
      incoming: { title: 'VP Eng', company: 'Acme' },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T0 },
    });

    expect(result.updates).toEqual({ title: 'VP Eng', company: 'Acme' });
    expect(result.provenance.title).toEqual({
      source: 'acc_hs',
      tier: 'hubspot',
      updatedAt: T0.toISOString(),
    });
    expect(result.provenance.company).toEqual({
      source: 'acc_hs',
      tier: 'hubspot',
      updatedAt: T0.toISOString(),
    });
  });
});

describe('resolveFieldUpdates — tier precedence', () => {
  it('higher-tier incoming OVERWRITES lower-tier existing (Apollo → HubSpot wins)', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_apo', tier: 'apollo', updatedAt: T0.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: 'VP Eng' },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T1 },
    });

    expect(result.updates).toEqual({ title: 'VP Eng' });
    expect(result.provenance.title.tier).toBe('hubspot');
  });

  it('lower-tier incoming is SKIPPED when existing is higher (HubSpot → Apollo loses)', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T0.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: 'Head of Engineering' },
      source: { accountId: 'acc_apo', tier: 'apollo', now: T1 },
    });

    expect(result.updates).toEqual({});
    // Provenance unchanged.
    expect(result.provenance.title.tier).toBe('hubspot');
    expect(result.provenance.title.updatedAt).toBe(T0.toISOString());
  });

  it('manual edits are sticky against all vendor sources', () => {
    const existing: FieldProvenance = {
      title: { source: 'manual', tier: 'manual', updatedAt: T0.toISOString() },
    };
    for (const tier of ['hubspot', 'salesforce', 'apollo', 'zoominfo', 'csv'] as const) {
      const result = resolveFieldUpdates({
        existingProvenance: existing,
        incoming: { title: 'New Vendor Value' },
        source: { accountId: 'acc_x', tier, now: T2 },
      });
      expect(result.updates).toEqual({});
      expect(result.provenance.title.source).toBe('manual');
    }
  });
});

describe('resolveFieldUpdates — same-tier last-write-wins', () => {
  it('newer same-tier update wins (HubSpot acc-A then HubSpot acc-A again later)', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T0.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: 'Updated Title' },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T1 },
    });

    expect(result.updates).toEqual({ title: 'Updated Title' });
    expect(result.provenance.title.updatedAt).toBe(T1.toISOString());
  });

  it('older or equal-time same-tier update is skipped (stale data does not flap)', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T2.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: 'Stale Replay' },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T0 },
    });

    expect(result.updates).toEqual({});
    expect(result.provenance.title.updatedAt).toBe(T2.toISOString());
  });

  it('cross-source same-tier last-write-wins (HubSpot then Salesforce, same tier)', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T0.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: 'Salesforce Says' },
      source: { accountId: 'acc_sf', tier: 'salesforce', now: T1 },
    });

    expect(result.updates).toEqual({ title: 'Salesforce Says' });
    expect(result.provenance.title.source).toBe('acc_sf');
    expect(result.provenance.title.tier).toBe('salesforce');
  });
});

describe('resolveFieldUpdates — empty / null guards', () => {
  it('skips null incoming values (vendor cannot null-out existing data)', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T0.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: null },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T1 },
    });

    expect(result.updates).toEqual({});
    expect(result.provenance.title.updatedAt).toBe(T0.toISOString());
  });

  it('skips empty-string incoming values', () => {
    const result = resolveFieldUpdates({
      existingProvenance: {},
      incoming: { title: '', company: 'Acme' },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T0 },
    });

    expect(result.updates).toEqual({ company: 'Acme' });
    expect(result.provenance.title).toBeUndefined();
  });

  it('skips undefined incoming values', () => {
    const result = resolveFieldUpdates({
      existingProvenance: {},
      incoming: { title: undefined, company: 'Acme' },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T0 },
    });

    expect(result.updates).toEqual({ company: 'Acme' });
  });

  it('empty incoming object → no updates, provenance preserved', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T0.toISOString() },
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: {},
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T1 },
    });

    expect(result.updates).toEqual({});
    expect(result.provenance).toEqual(existing);
  });
});

describe('resolveFieldUpdates — multi-field mixed outcomes', () => {
  it('per-field: write some, skip others based on tier', () => {
    const existing: FieldProvenance = {
      title: { source: 'manual', tier: 'manual', updatedAt: T0.toISOString() },
      company: { source: 'acc_apo', tier: 'apollo', updatedAt: T0.toISOString() },
      // linkedinUrl: no provenance
    };
    const result = resolveFieldUpdates({
      existingProvenance: existing,
      incoming: {
        title: 'Should not overwrite manual',
        company: 'HubSpot Says Beats Apollo',
        linkedinUrl: 'https://linkedin.com/in/sarah-new',
      },
      source: { accountId: 'acc_hs', tier: 'hubspot', now: T1 },
    });

    expect(result.updates).toEqual({
      company: 'HubSpot Says Beats Apollo',
      linkedinUrl: 'https://linkedin.com/in/sarah-new',
    });
    expect(result.provenance.title.source).toBe('manual');
    expect(result.provenance.company.tier).toBe('hubspot');
    expect(result.provenance.linkedinUrl.tier).toBe('hubspot');
  });
});

describe('resolveFieldUpdates — purity', () => {
  it('does not mutate the input existingProvenance object', () => {
    const existing: FieldProvenance = {
      title: { source: 'acc_hs', tier: 'hubspot', updatedAt: T0.toISOString() },
    };
    const snapshot = JSON.stringify(existing);

    resolveFieldUpdates({
      existingProvenance: existing,
      incoming: { title: 'New', company: 'New Co' },
      source: { accountId: 'acc_sf', tier: 'salesforce', now: T1 },
    });

    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('defaults now() to current Date when not provided', () => {
    const before = Date.now();
    const result = resolveFieldUpdates({
      existingProvenance: {},
      incoming: { title: 'X' },
      source: { accountId: 'acc_hs', tier: 'hubspot' },
    });
    const after = Date.now();

    const recorded = new Date(result.provenance.title.updatedAt).getTime();
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });
});

describe('tierFromConnectorKind', () => {
  it('maps each ConnectorKind to its matching SourceTier', () => {
    expect(tierFromConnectorKind('hubspot')).toBe('hubspot');
    expect(tierFromConnectorKind('salesforce')).toBe('salesforce');
    expect(tierFromConnectorKind('apollo')).toBe('apollo');
    expect(tierFromConnectorKind('zoominfo')).toBe('zoominfo');
    expect(tierFromConnectorKind('csv')).toBe('csv');
  });
});
