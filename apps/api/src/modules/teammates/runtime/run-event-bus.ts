import { Injectable, Logger } from '@nestjs/common';

/**
 * Run-event bus for live progress streaming (T4e.1).
 *
 * The runtime emits events at meaningful state transitions; subscribers
 * (the SSE endpoint, future webhooks, audit-log tail UIs) consume them.
 *
 * v1 implementation is in-memory and per-process. That's sufficient because
 * the API + worker still run in the same NestJS process; the same singleton
 * publishes (worker side) and subscribes (controller side). When we move
 * the worker out to its own process (T9 + queue scale trigger), the
 * interface stays — the implementation swaps to Postgres LISTEN/NOTIFY
 * (or Redis pubsub if BullMQ has already arrived).
 *
 * Memory hygiene:
 *   - Per-run event buffer for late-join replay (the SSE client may connect
 *     after the worker has already emitted several events).
 *   - Terminal events trigger a cleanup timer: 60s after a `run_completed |
 *     run_abstained | run_failed` event, the bus drops the buffer + closes
 *     all subscribers for that run.
 *   - No global cap on the buffer — a runaway looping run would accumulate
 *     events, but the maxToolCalls bound (default 20) keeps the total well
 *     under 50 events per run.
 */

// ─── Event types ────────────────────────────────────────────────────

export type RunEventType =
  | 'model_call_started'
  | 'model_call_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'draft_emitted'
  | 'run_completed'
  | 'run_abstained'
  | 'run_failed';

interface BaseRunEvent {
  /** AgentRun.id this event belongs to. */
  runId: string;
  /** ISO-8601 timestamp set when the event is published. */
  at: string;
}

export type RunEvent =
  | (BaseRunEvent & {
      type: 'model_call_started';
      data: { modelName: string; turn: number };
    })
  | (BaseRunEvent & {
      type: 'model_call_completed';
      data: {
        modelCallId: string;
        modelName: string;
        inputTokens: number;
        outputTokens: number;
        costCents: number;
        /** Total cost of the run including this call. */
        runCostCents: number;
      };
    })
  | (BaseRunEvent & {
      type: 'tool_call_started';
      data: {
        toolName: string;
        toolSeq: number;
        args: unknown;
      };
    })
  | (BaseRunEvent & {
      type: 'tool_call_completed';
      data: {
        toolName: string;
        toolSeq: number;
        durationMs: number;
        isError: boolean;
        /** Short summary for UI display (e.g. URL fetched, results count). */
        summary?: string;
      };
    })
  | (BaseRunEvent & {
      type: 'draft_emitted';
      data: {
        draftId: string;
        persistedClaimCount: number;
        droppedUncitedCount: number;
        droppedDanglingCount: number;
      };
    })
  | (BaseRunEvent & {
      type: 'run_completed';
      data: {
        draftId: string;
        costCents: number;
        toolCallCount: number;
      };
    })
  | (BaseRunEvent & {
      type: 'run_abstained';
      data: {
        reason: string;
        costCents: number;
        toolCallCount: number;
      };
    })
  | (BaseRunEvent & {
      type: 'run_failed';
      data: { message: string };
    });

const TERMINAL_TYPES: ReadonlySet<RunEventType> = new Set([
  'run_completed',
  'run_abstained',
  'run_failed',
]);

const BUFFER_CLEANUP_MS = 60_000;

export type RunEventSubscriber = (event: RunEvent) => void;

/** Public bus interface — implementations: in-memory now, pg LISTEN/NOTIFY later. */
export interface RunEventBus {
  publish(event: RunEvent): void;
  /** Subscribe to all future events for `runId`. Returns an unsubscribe handle. */
  subscribe(runId: string, sub: RunEventSubscriber): () => void;
  /** Snapshot of events already published for `runId` (for late-join replay). */
  snapshot(runId: string): RunEvent[];
}

@Injectable()
export class InMemoryRunEventBus implements RunEventBus {
  private readonly logger = new Logger(InMemoryRunEventBus.name);
  private readonly buffers = new Map<string, RunEvent[]>();
  private readonly subscribers = new Map<string, Set<RunEventSubscriber>>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  /** Override for tests so we don't hold open setTimeouts. */
  private readonly bufferCleanupMs: number;

  constructor(opts: { bufferCleanupMs?: number } = {}) {
    this.bufferCleanupMs = opts.bufferCleanupMs ?? BUFFER_CLEANUP_MS;
  }

  publish(event: RunEvent): void {
    const buf = this.buffers.get(event.runId) ?? [];
    buf.push(event);
    this.buffers.set(event.runId, buf);

    const subs = this.subscribers.get(event.runId);
    if (subs) {
      for (const sub of subs) {
        try {
          sub(event);
        } catch (err) {
          // A misbehaving subscriber must not poison the publisher. Log
          // and drop the bad subscription so future emits don't replay
          // the failure.
          this.logger.warn(
            `subscriber for run=${event.runId} threw on event=${event.type}; removing it`,
          );
          subs.delete(sub);
        }
      }
    }

    if (TERMINAL_TYPES.has(event.type)) {
      this.scheduleCleanup(event.runId);
    }
  }

  subscribe(runId: string, sub: RunEventSubscriber): () => void {
    let subs = this.subscribers.get(runId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(runId, subs);
    }
    subs.add(sub);
    return () => {
      const current = this.subscribers.get(runId);
      if (!current) return;
      current.delete(sub);
      if (current.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  snapshot(runId: string): RunEvent[] {
    return [...(this.buffers.get(runId) ?? [])];
  }

  /** Test-only: drop all buffered events + cancel cleanup timers. */
  resetForTests(): void {
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.buffers.clear();
    this.subscribers.clear();
  }

  private scheduleCleanup(runId: string): void {
    const existing = this.cleanupTimers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.buffers.delete(runId);
      this.subscribers.delete(runId);
      this.cleanupTimers.delete(runId);
    }, this.bufferCleanupMs);
    // Don't keep the Node event loop alive for buffer cleanup alone.
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimers.set(runId, timer);
  }
}

/** DI token for the bus. */
export const RUN_EVENT_BUS = Symbol.for('@getbeyond/run-event-bus');
