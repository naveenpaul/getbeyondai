'use client';

import { useEffect, useRef, useState } from 'react';
import type { CampaignEvent, CampaignEventType } from '@getbeyond/shared';
import { buildCampaignStreamUrl } from './api-client';

/**
 * SSE consumer for a campaign's run stream (GET /campaigns/:id/stream).
 *
 * Mirrors useAgentStream, but the campaign stream carries a different event
 * union (CampaignEvent — phases + `tool_activity` wrapping a RunEvent) with
 * its own terminal set, so it can't reuse the RunEvent-typed agent hook.
 *
 * Opens an EventSource against the campaign stream URL and accumulates
 * CampaignEvents until a terminal one (`campaign_completed` / `campaign_failed`)
 * arrives, then closes. Browser EventSource auto-reconnects on transient
 * errors; we don't re-implement backoff. Events are de-duplicated by a stable
 * key so a reconnect-replay never double-renders a row.
 */

export type CampaignConnectionState =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error';

interface UseCampaignStreamArgs {
  /** Campaign id. Pass null to skip subscribing (e.g. before create). */
  campaignId: string | null;
}

interface UseCampaignStreamResult {
  events: CampaignEvent[];
  connectionState: CampaignConnectionState;
  terminated: boolean;
  last: CampaignEvent | null;
}

// Every CampaignEvent type the API emits. EventSource dispatches by the SSE
// `event:` field, which carries the discriminant `type`, so we attach one
// listener per type.
const HANDLED_TYPES: readonly CampaignEventType[] = [
  'campaign_started',
  'icp_derived',
  'sourcing_started',
  'sourcing_completed',
  'candidate_qualified',
  'campaign_completed',
  'campaign_failed',
  'tool_activity',
];

// Terminal event types: when one arrives we stop listening and close the stream.
// Defined locally (typed against the shared CampaignEventType union, so it can't
// drift from the contract) rather than importing the shared runtime Set —
// @getbeyond/shared is a CommonJS build, and importing a runtime value from it
// into a client module trips Next's React Fast Refresh ("Cannot use 'import.meta'
// outside a module"). All other shared usage here is type-only and erased.
const TERMINAL_TYPES: ReadonlySet<CampaignEventType> = new Set([
  'campaign_completed',
  'campaign_failed',
]);

export function useCampaignStream({
  campaignId,
}: UseCampaignStreamArgs): UseCampaignStreamResult {
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [connectionState, setConnectionState] =
    useState<CampaignConnectionState>('connecting');
  const [terminated, setTerminated] = useState(false);
  const deliveredRef = useRef(new Set<string>());

  useEffect(() => {
    if (!campaignId) return;

    deliveredRef.current = new Set();
    setEvents([]);
    setTerminated(false);
    setConnectionState('connecting');

    const es = new EventSource(buildCampaignStreamUrl(campaignId), {
      withCredentials: true,
    });

    es.onopen = () => setConnectionState('open');
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setConnectionState('closed');
      } else {
        setConnectionState('error');
      }
    };

    const handle = (event: MessageEvent): void => {
      let parsed: CampaignEvent;
      try {
        parsed = JSON.parse(event.data) as CampaignEvent;
      } catch {
        return;
      }
      const key = `${parsed.type}|${parsed.at}|${JSON.stringify(parsed.data)}`;
      if (deliveredRef.current.has(key)) return;
      deliveredRef.current.add(key);

      setEvents((prev) => [...prev, parsed]);
      if (TERMINAL_TYPES.has(parsed.type)) {
        setTerminated(true);
        es.close();
        setConnectionState('closed');
      }
    };

    for (const type of HANDLED_TYPES) {
      es.addEventListener(type, handle as (e: Event) => void);
    }

    return () => {
      es.close();
    };
  }, [campaignId]);

  return {
    events,
    connectionState,
    terminated,
    last: events.length > 0 ? (events[events.length - 1] ?? null) : null,
  };
}
