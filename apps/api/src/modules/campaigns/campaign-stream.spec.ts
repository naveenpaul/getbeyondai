import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MessageEvent } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type { CampaignEvent, RunEvent } from '@getbeyond/shared';
import { InMemoryRunEventBus } from '../teammates/runtime/run-event-bus';
import { buildCampaignStreamObservable } from './campaign-stream';

/**
 * Unit tests for the campaign SSE Observable. Uses the REAL InMemoryRunEventBus
 * (campaign events ride the same transport, cast at the publish boundary) and a
 * short cleanup window so no timers leak. Explicit vitest imports —
 * `globals: false`.
 */

const CID = 'camp-1';

function started(at: string): CampaignEvent {
  return {
    type: 'campaign_started',
    campaignId: CID,
    at,
    data: { goal: 'g' },
  };
}

function completed(at: string): CampaignEvent {
  return {
    type: 'campaign_completed',
    campaignId: CID,
    at,
    data: { candidateCount: 1, costCents: 5 },
  };
}

function failed(at: string): CampaignEvent {
  return {
    type: 'campaign_failed',
    campaignId: CID,
    at,
    data: { message: 'boom' },
  };
}

/**
 * Publish a campaign event onto the RunEvent-typed bus.
 *
 * The bus routes/buffers by `event.runId`; `buildCampaignStreamObservable`
 * subscribes by `campaignId`. So for the bus to deliver to the observable, the
 * published event's routing key must equal the campaignId. We set `runId` to the
 * campaignId here to exercise the observable's own replay/dedup/terminal logic.
 *
 * NOTE: the production worker publishes campaign events WITHOUT a `runId` (they
 * carry `campaignId`), so the live bus routes them under `undefined` and the
 * stream never receives them — see the bug note in the handoff. This helper
 * works around that to test the observable in isolation.
 */
function publish(bus: InMemoryRunEventBus, e: CampaignEvent): void {
  bus.publish({ ...e, runId: e.campaignId } as unknown as RunEvent);
}

describe('buildCampaignStreamObservable', () => {
  let bus: InMemoryRunEventBus;
  let sub: Subscription | undefined;

  beforeEach(() => {
    bus = new InMemoryRunEventBus({ bufferCleanupMs: 50 });
  });

  afterEach(() => {
    sub?.unsubscribe();
    bus.resetForTests();
  });

  function collect(
    status: 'draft' | 'running' | 'completed' | 'failed',
  ): { events: MessageEvent[]; completed: boolean } {
    const events: MessageEvent[] = [];
    let isComplete = false;
    const obs = buildCampaignStreamObservable({
      campaignId: CID,
      campaignStatus: status,
      eventBus: bus,
    });
    sub = obs.subscribe({
      next: (e) => events.push(e),
      complete: () => {
        isComplete = true;
      },
    });
    return {
      get events() {
        return events;
      },
      get completed() {
        return isComplete;
      },
    } as { events: MessageEvent[]; completed: boolean };
  }

  it('replays buffered events first, in order', () => {
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    publish(bus, {
      type: 'icp_derived',
      campaignId: CID,
      at: '2020-01-01T00:00:01.000Z',
      data: {
        icp: {
          summary: 's',
          keywords: [],
          employeeCountMax: null,
          fundingStages: [],
        },
      },
    });

    const result = collect('running');

    expect(result.events.map((e) => e.type)).toEqual([
      'campaign_started',
      'icp_derived',
    ]);
    // Each MessageEvent.type is the event's own type.
    expect(result.events[0]?.data).toMatchObject({ type: 'campaign_started' });
  });

  it('delivers live events after subscribing', () => {
    const result = collect('running');
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    expect(result.events.map((e) => e.type)).toEqual(['campaign_started']);
  });

  it('dedups events with identical type|at|data', () => {
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    const result = collect('running');
    // Republish the identical event onto the live channel.
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    expect(result.events).toHaveLength(1);
  });

  it('closes the stream on a terminal campaign_completed event', () => {
    const result = collect('running');
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    expect(result.completed).toBe(false);
    publish(bus, completed('2020-01-01T00:00:02.000Z'));
    expect(result.completed).toBe(true);
    expect(result.events.at(-1)?.type).toBe('campaign_completed');
  });

  it('closes the stream on a terminal campaign_failed event', () => {
    const result = collect('running');
    publish(bus, failed('2020-01-01T00:00:02.000Z'));
    expect(result.completed).toBe(true);
    expect(result.events.at(-1)?.type).toBe('campaign_failed');
  });

  it('synthesizes a terminal when the campaign is already completed with no buffered terminal', () => {
    // No events buffered, but the DB row says completed.
    const result = collect('completed');
    expect(result.completed).toBe(true);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev?.type).toBe('campaign_completed');
    expect(ev?.data).toMatchObject({
      type: 'campaign_completed',
      campaignId: CID,
      data: { synthesized: true, status: 'completed' },
    });
  });

  it('synthesizes a terminal for an already-failed campaign', () => {
    const result = collect('failed');
    expect(result.completed).toBe(true);
    expect(result.events[0]?.type).toBe('campaign_failed');
    expect(result.events[0]?.data).toMatchObject({
      data: { synthesized: true, status: 'failed' },
    });
  });

  it('does NOT synthesize when a terminal is already in the replay buffer', () => {
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    publish(bus, completed('2020-01-01T00:00:02.000Z'));

    const result = collect('completed');

    // Exactly the buffered events; no extra synthesized terminal.
    expect(result.events.map((e) => e.type)).toEqual([
      'campaign_started',
      'campaign_completed',
    ]);
    // The buffered terminal isn't the synthesized one.
    expect(result.events.at(-1)?.data).not.toMatchObject({
      data: { synthesized: true },
    });
    expect(result.completed).toBe(true);
  });

  it('does not synthesize / close for a still-running campaign with no terminal', () => {
    const result = collect('running');
    publish(bus, started('2020-01-01T00:00:00.000Z'));
    expect(result.completed).toBe(false);
  });
});
