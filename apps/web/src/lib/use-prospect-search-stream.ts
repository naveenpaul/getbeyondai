'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProspectSearchEvent, ProspectSearchEventType } from '@getbeyond/shared';
import { buildProspectSearchStreamUrl } from './api-client';

/**
 * SSE consumer for a prospectSearch's run stream (GET /prospect-searches/:id/stream).
 *
 * Mirrors useAgentStream, but the prospectSearch stream carries a different event
 * union (ProspectSearchEvent — phases + `tool_activity` wrapping a RunEvent) with
 * its own terminal set, so it can't reuse the RunEvent-typed agent hook.
 *
 * Opens an EventSource against the prospectSearch stream URL and accumulates
 * ProspectSearchEvents until a terminal one (`search_completed` / `search_failed`)
 * arrives, then closes. Browser EventSource auto-reconnects on transient
 * errors; we don't re-implement backoff. Events are de-duplicated by a stable
 * key so a reconnect-replay never double-renders a row.
 */

export type ProspectSearchConnectionState =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error';

interface UseProspectSearchStreamArgs {
  /** ProspectSearch id. Pass null to skip subscribing (e.g. before create). */
  prospectSearchId: string | null;
}

interface UseProspectSearchStreamResult {
  events: ProspectSearchEvent[];
  connectionState: ProspectSearchConnectionState;
  terminated: boolean;
  last: ProspectSearchEvent | null;
}

// Every ProspectSearchEvent type the API emits. EventSource dispatches by the SSE
// `event:` field, which carries the discriminant `type`, so we attach one
// listener per type.
const HANDLED_TYPES: readonly ProspectSearchEventType[] = [
  'search_started',
  'icp_derived',
  'sourcing_started',
  'sourcing_completed',
  'prospect_qualified',
  'search_completed',
  'search_failed',
  'tool_activity',
];

// Terminal event types: when one arrives we stop listening and close the stream.
// Defined locally (typed against the shared ProspectSearchEventType union, so it can't
// drift from the contract) rather than importing the shared runtime Set —
// @getbeyond/shared is a CommonJS build, and importing a runtime value from it
// into a client module trips Next's React Fast Refresh ("Cannot use 'import.meta'
// outside a module"). All other shared usage here is type-only and erased.
const TERMINAL_TYPES: ReadonlySet<ProspectSearchEventType> = new Set([
  'search_completed',
  'search_failed',
]);

export function useProspectSearchStream({
  prospectSearchId,
}: UseProspectSearchStreamArgs): UseProspectSearchStreamResult {
  const [events, setEvents] = useState<ProspectSearchEvent[]>([]);
  const [connectionState, setConnectionState] =
    useState<ProspectSearchConnectionState>('connecting');
  const [terminated, setTerminated] = useState(false);
  const deliveredRef = useRef(new Set<string>());

  useEffect(() => {
    if (!prospectSearchId) return;

    deliveredRef.current = new Set();
    setEvents([]);
    setTerminated(false);
    setConnectionState('connecting');

    const es = new EventSource(buildProspectSearchStreamUrl(prospectSearchId), {
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
      let parsed: ProspectSearchEvent;
      try {
        parsed = JSON.parse(event.data) as ProspectSearchEvent;
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
  }, [prospectSearchId]);

  return {
    events,
    connectionState,
    terminated,
    last: events.length > 0 ? (events[events.length - 1] ?? null) : null,
  };
}
