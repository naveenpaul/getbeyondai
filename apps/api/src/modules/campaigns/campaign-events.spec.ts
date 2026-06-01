import { describe, expect, it } from 'vitest';
import type {
  IcpSummary,
  QualifiedCandidate,
  RunEvent,
} from '@getbeyond/shared';
import {
  campaignCompleted,
  campaignFailed,
  campaignStarted,
  candidateQualified,
  icpDerived,
  isTerminalCampaignEvent,
  sourcingCompleted,
  sourcingStarted,
  toBusEvent,
  toolActivity,
} from './campaign-events';

/**
 * Typed factory helpers for the campaign SSE event union. These assert shape
 * correctness (discriminant `type`, `campaignId`, a valid ISO `at`, and the
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

const CANDIDATE: QualifiedCandidate = {
  name: 'Acme',
  domain: 'acme.com',
  linkedinUrl: null,
  fitScore: 0.8,
  rationale: 'good fit',
  claims: [],
};

describe('campaign-events factories', () => {
  it('campaignStarted', () => {
    const e = campaignStarted(CID, 'find lookalikes');
    expect(e.type).toBe('campaign_started');
    expect(e.campaignId).toBe(CID);
    expectIso(e.at);
    if (e.type === 'campaign_started') {
      expect(e.data).toEqual({ goal: 'find lookalikes' });
    }
  });

  it('icpDerived', () => {
    const e = icpDerived(CID, ICP);
    expect(e.type).toBe('icp_derived');
    expect(e.campaignId).toBe(CID);
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
      expect(e.data).toEqual({ summary: 'Read 12 companies', candidateCount: 12 });
    }
  });

  it('candidateQualified', () => {
    const e = candidateQualified(CID, CANDIDATE, 2, 5);
    expect(e.type).toBe('candidate_qualified');
    if (e.type === 'candidate_qualified') {
      expect(e.data).toEqual({ candidate: CANDIDATE, index: 2, total: 5 });
    }
  });

  it('campaignCompleted', () => {
    const e = campaignCompleted(CID, 7, 123);
    expect(e.type).toBe('campaign_completed');
    if (e.type === 'campaign_completed') {
      expect(e.data).toEqual({ candidateCount: 7, costCents: 123 });
    }
  });

  it('campaignFailed', () => {
    const e = campaignFailed(CID, 'boom');
    expect(e.type).toBe('campaign_failed');
    if (e.type === 'campaign_failed') {
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
    expect(e.campaignId).toBe(CID);
    expectIso(e.at);
    if (e.type === 'tool_activity') {
      expect(e.data.event).toEqual(inner);
    }
  });
});

describe('isTerminalCampaignEvent', () => {
  it('is true for terminal campaign events', () => {
    expect(isTerminalCampaignEvent(campaignCompleted(CID, 0, 0))).toBe(true);
    expect(isTerminalCampaignEvent(campaignFailed(CID, 'x'))).toBe(true);
  });

  it('is false for non-terminal campaign events', () => {
    expect(isTerminalCampaignEvent(campaignStarted(CID, 'g'))).toBe(false);
    expect(isTerminalCampaignEvent(icpDerived(CID, ICP))).toBe(false);
    expect(isTerminalCampaignEvent(sourcingStarted(CID, 'p'))).toBe(false);
  });
});

describe('toBusEvent', () => {
  // Regression: the shared RunEventBus routes/buffers by `runId`, but campaign
  // events key on `campaignId`. Without this stamp, published campaign events
  // land under `runId: undefined` and the SSE stream (subscribed by campaignId)
  // never receives them — the whole live chat stream silently breaks.
  it('stamps runId = campaignId so the bus routes to the stream', () => {
    const bus = toBusEvent(campaignStarted(CID, 'g')) as unknown as {
      runId: string;
      type: string;
      campaignId: string;
    };
    expect(bus.runId).toBe(CID);
    expect(bus.campaignId).toBe(CID);
    expect(bus.type).toBe('campaign_started');
  });

  it('preserves the original event payload', () => {
    const original = campaignFailed(CID, 'boom');
    const bus = toBusEvent(original) as unknown as typeof original & {
      runId: string;
    };
    expect(bus.data).toEqual({ message: 'boom' });
    expect(bus.at).toBe(original.at);
  });
});
