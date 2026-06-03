import { describe, expect, it } from 'vitest';
import type {
  IcpSummary,
  QualifiedProspect,
  RunEvent,
} from '@getbeyond/shared';
import {
  searchCompleted,
  searchFailed,
  searchStarted,
  prospectQualified,
  icpDerived,
  isTerminalProspectSearchEvent,
  sourcingCompleted,
  sourcingStarted,
  toBusEvent,
  toolActivity,
} from './prospect-search-events';

/**
 * Typed factory helpers for the prospectSearch SSE event union. These assert shape
 * correctness (discriminant `type`, `prospectSearchId`, a valid ISO `at`, and the
 * per-type `data` payload). Explicit vitest imports — `globals: false`.
 */

const CID = 'camp-1';

function expectIso(at: string): void {
  expect(typeof at).toBe('string');
  expect(Number.isNaN(Date.parse(at))).toBe(false);
}

const ICP: IcpSummary = {
  summary: 'B2B SaaS',
  keywords: ['saas'],
  employeeCountMax: 50,
  fundingStages: ['seed'],
};

const CANDIDATE: QualifiedProspect = {
  name: 'Acme',
  domain: 'acme.com',
  linkedinUrl: null,
  fitScore: 0.8,
  rationale: 'good fit',
  claims: [],
};

describe('prospect-search-events factories', () => {
  it('searchStarted', () => {
    const e = searchStarted(CID, 'find lookalikes');
    expect(e.type).toBe('search_started');
    expect(e.prospectSearchId).toBe(CID);
    expectIso(e.at);
    if (e.type === 'search_started') {
      expect(e.data).toEqual({ goal: 'find lookalikes' });
    }
  });

  it('icpDerived', () => {
    const e = icpDerived(CID, ICP);
    expect(e.type).toBe('icp_derived');
    expect(e.prospectSearchId).toBe(CID);
    expectIso(e.at);
    if (e.type === 'icp_derived') {
      expect(e.data.icp).toEqual(ICP);
    }
  });

  it('sourcingStarted', () => {
    const e = sourcingStarted(CID, 'contact_list');
    expect(e.type).toBe('sourcing_started');
    if (e.type === 'sourcing_started') {
      expect(e.data).toEqual({ provider: 'contact_list' });
    }
  });

  it('sourcingCompleted', () => {
    const e = sourcingCompleted(CID, 'Read 12 companies', 12);
    expect(e.type).toBe('sourcing_completed');
    if (e.type === 'sourcing_completed') {
      expect(e.data).toEqual({ summary: 'Read 12 companies', prospectCount: 12 });
    }
  });

  it('prospectQualified', () => {
    const e = prospectQualified(CID, CANDIDATE, 2, 5);
    expect(e.type).toBe('prospect_qualified');
    if (e.type === 'prospect_qualified') {
      expect(e.data).toEqual({ prospect: CANDIDATE, index: 2, total: 5 });
    }
  });

  it('searchCompleted', () => {
    const e = searchCompleted(CID, 7, 123);
    expect(e.type).toBe('search_completed');
    if (e.type === 'search_completed') {
      expect(e.data).toEqual({ prospectCount: 7, costCents: 123 });
    }
  });

  it('searchFailed', () => {
    const e = searchFailed(CID, 'boom');
    expect(e.type).toBe('search_failed');
    if (e.type === 'search_failed') {
      expect(e.data).toEqual({ message: 'boom' });
    }
  });

  it('toolActivity wraps a RunEvent and re-stamps `at` fresh', () => {
    const inner: RunEvent = {
      type: 'tool_call_started',
      runId: 'run-x',
      at: '2020-01-01T00:00:00.000Z',
      data: { tool: 'brave_search', turn: 0 },
    } as unknown as RunEvent;
    const e = toolActivity(CID, inner);
    expect(e.type).toBe('tool_activity');
    expect(e.prospectSearchId).toBe(CID);
    expectIso(e.at);
    if (e.type === 'tool_activity') {
      expect(e.data.event).toEqual(inner);
    }
  });
});

describe('isTerminalProspectSearchEvent', () => {
  it('is true for terminal prospectSearch events', () => {
    expect(isTerminalProspectSearchEvent(searchCompleted(CID, 0, 0))).toBe(true);
    expect(isTerminalProspectSearchEvent(searchFailed(CID, 'x'))).toBe(true);
  });

  it('is false for non-terminal prospectSearch events', () => {
    expect(isTerminalProspectSearchEvent(searchStarted(CID, 'g'))).toBe(false);
    expect(isTerminalProspectSearchEvent(icpDerived(CID, ICP))).toBe(false);
    expect(isTerminalProspectSearchEvent(sourcingStarted(CID, 'p'))).toBe(false);
  });
});

describe('toBusEvent', () => {
  // Regression: the shared RunEventBus routes/buffers by `runId`, but prospectSearch
  // events key on `prospectSearchId`. Without this stamp, published prospectSearch events
  // land under `runId: undefined` and the SSE stream (subscribed by prospectSearchId)
  // never receives them — the whole live chat stream silently breaks.
  it('stamps runId = prospectSearchId so the bus routes to the stream', () => {
    const bus = toBusEvent(searchStarted(CID, 'g')) as unknown as {
      runId: string;
      type: string;
      prospectSearchId: string;
    };
    expect(bus.runId).toBe(CID);
    expect(bus.prospectSearchId).toBe(CID);
    expect(bus.type).toBe('search_started');
  });

  it('preserves the original event payload', () => {
    const original = searchFailed(CID, 'boom');
    const bus = toBusEvent(original) as unknown as typeof original & {
      runId: string;
    };
    expect(bus.data).toEqual({ message: 'boom' });
    expect(bus.at).toBe(original.at);
  });
});
