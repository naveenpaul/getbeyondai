import { type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  TERMINAL_CAMPAIGN_EVENT_TYPES,
  type CampaignEvent,
  type CampaignStatus,
} from '@getbeyond/shared';
import type { RunEventBus } from '../teammates/runtime/run-event-bus';

const SSE_HEARTBEAT_MS = 15_000;

/**
 * SSE Observable for a campaign's progress stream — the campaign-event analogue
 * of the teammate runtime's `buildRunStreamObservable`. We need a separate
 * builder because campaigns terminate on `campaign_completed | campaign_failed`
 * (not the RunEvent terminals) and the synthesized-terminal fallback maps the
 * campaign's own status enum.
 *
 * The orchestrator publishes `CampaignEvent`s onto the SAME RunEventBus the
 * teammate runtime uses, keyed by campaignId. The bus is event-shape-agnostic
 * about `data`, but its terminal-cleanup logic keys on RunEvent terminal types
 * — that only affects buffer GC timing, not correctness here, since this
 * builder enforces its own campaign terminal semantics and closes the stream.
 *
 * Connection lifecycle (mirrors the teammate builder):
 *   - Replay buffered events first (mid-run reconnect sees history).
 *   - Subscribe to live events; dedup on `type|at|JSON.stringify(data)`.
 *   - Close on a terminal campaign event.
 *   - If the campaign is ALREADY terminal at connect time and no terminal event
 *     is in the replay buffer, synthesize one from the DB status so the client
 *     doesn't wait forever.
 *   - Heartbeats every 15s keep stale connections detectable.
 */
export function buildCampaignStreamObservable(args: {
  campaignId: string;
  campaignStatus: CampaignStatus;
  eventBus: RunEventBus;
}): Observable<MessageEvent> {
  const { campaignId, campaignStatus, eventBus } = args;

  return new Observable<MessageEvent>((subscriber) => {
    const delivered = new Set<string>();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribeBus: (() => void) | undefined;

    const terminate = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeBus?.();
      subscriber.complete();
    };

    const emit = (event: CampaignEvent): void => {
      const key = `${event.type}|${event.at}|${JSON.stringify(event.data)}`;
      if (delivered.has(key)) return;
      delivered.add(key);
      subscriber.next({ type: event.type, data: event });
      if (TERMINAL_CAMPAIGN_EVENT_TYPES.has(event.type)) terminate();
    };

    // The bus is typed for RunEvent; campaign events ride the same transport.
    // Cast at this boundary only — every payload we publish for `campaignId` is
    // a CampaignEvent.
    for (const event of eventBus.snapshot(campaignId)) {
      emit(event as unknown as CampaignEvent);
    }
    unsubscribeBus = eventBus.subscribe(campaignId, (event) =>
      emit(event as unknown as CampaignEvent),
    );

    const replayHasTerminal = [...delivered].some((key) =>
      [...TERMINAL_CAMPAIGN_EVENT_TYPES].some((t) => key.startsWith(`${t}|`)),
    );
    if (
      (campaignStatus === 'completed' || campaignStatus === 'failed') &&
      !replayHasTerminal
    ) {
      const type =
        campaignStatus === 'completed'
          ? 'campaign_completed'
          : 'campaign_failed';
      subscriber.next({
        type,
        data: {
          type,
          campaignId,
          at: new Date().toISOString(),
          data: { synthesized: true, status: campaignStatus },
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
