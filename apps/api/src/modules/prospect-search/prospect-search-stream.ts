import { type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  TERMINAL_PROSPECT_SEARCH_EVENT_TYPES,
  type ProspectSearchEvent,
  type ProspectSearchStatus,
} from '@getbeyond/shared';
import type { RunEventBus } from '../teammates/runtime/run-event-bus';

const SSE_HEARTBEAT_MS = 15_000;

/**
 * SSE Observable for a prospectSearch's progress stream — the prospectSearch-event analogue
 * of the teammate runtime's `buildRunStreamObservable`. We need a separate
 * builder because prospectSearches terminate on `search_completed | search_failed`
 * (not the RunEvent terminals) and the synthesized-terminal fallback maps the
 * prospectSearch's own status enum.
 *
 * The orchestrator publishes `ProspectSearchEvent`s onto the SAME RunEventBus the
 * teammate runtime uses, keyed by prospectSearchId. The bus is event-shape-agnostic
 * about `data`, but its terminal-cleanup logic keys on RunEvent terminal types
 * — that only affects buffer GC timing, not correctness here, since this
 * builder enforces its own prospectSearch terminal semantics and closes the stream.
 *
 * Connection lifecycle (mirrors the teammate builder):
 *   - Replay buffered events first (mid-run reconnect sees history).
 *   - Subscribe to live events; dedup on `type|at|JSON.stringify(data)`.
 *   - Close on a terminal prospectSearch event.
 *   - If the prospectSearch is ALREADY terminal at connect time and no terminal event
 *     is in the replay buffer, synthesize one from the DB status so the client
 *     doesn't wait forever.
 *   - Heartbeats every 15s keep stale connections detectable.
 */
export function buildProspectSearchStreamObservable(args: {
  prospectSearchId: string;
  prospectSearchStatus: ProspectSearchStatus;
  eventBus: RunEventBus;
}): Observable<MessageEvent> {
  const { prospectSearchId, prospectSearchStatus, eventBus } = args;

  return new Observable<MessageEvent>((subscriber) => {
    const delivered = new Set<string>();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribeBus: (() => void) | undefined;

    const terminate = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeBus?.();
      subscriber.complete();
    };

    const emit = (event: ProspectSearchEvent): void => {
      const key = `${event.type}|${event.at}|${JSON.stringify(event.data)}`;
      if (delivered.has(key)) return;
      delivered.add(key);
      subscriber.next({ type: event.type, data: event });
      if (TERMINAL_PROSPECT_SEARCH_EVENT_TYPES.has(event.type)) terminate();
    };

    // The bus is typed for RunEvent; prospectSearch events ride the same transport.
    // Cast at this boundary only — every payload we publish for `prospectSearchId` is
    // a ProspectSearchEvent.
    for (const event of eventBus.snapshot(prospectSearchId)) {
      emit(event as unknown as ProspectSearchEvent);
    }
    unsubscribeBus = eventBus.subscribe(prospectSearchId, (event) =>
      emit(event as unknown as ProspectSearchEvent),
    );

    const replayHasTerminal = [...delivered].some((key) =>
      [...TERMINAL_PROSPECT_SEARCH_EVENT_TYPES].some((t) => key.startsWith(`${t}|`)),
    );
    if (
      (prospectSearchStatus === 'completed' || prospectSearchStatus === 'failed') &&
      !replayHasTerminal
    ) {
      const type =
        prospectSearchStatus === 'completed'
          ? 'search_completed'
          : 'search_failed';
      subscriber.next({
        type,
        data: {
          type,
          prospectSearchId,
          at: new Date().toISOString(),
          data: { synthesized: true, status: prospectSearchStatus },
        },
      });
      terminate();
      return () => undefined;
    }

    heartbeat = setInterval(() => {
      subscriber.next({
        type: 'heartbeat',
        data: { at: new Date().toISOString() },
      });
    }, SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    return () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeBus?.();
    };
  });
}
