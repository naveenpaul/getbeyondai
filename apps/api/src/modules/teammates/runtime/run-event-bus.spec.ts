import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunEventBus, type RunEvent } from './run-event-bus';

function modelCallStarted(runId = 'run-1', turn = 0): RunEvent {
  return {
    type: 'model_call_started',
    runId,
    at: new Date().toISOString(),
    data: { modelName: 'claude-sonnet-4-6', turn },
  };
}

function runCompleted(runId = 'run-1'): RunEvent {
  return {
    type: 'run_completed',
    runId,
    at: new Date().toISOString(),
    data: { draftId: 'd-1', costCents: 12, toolCallCount: 3 },
  };
}

describe('InMemoryRunEventBus — publish + subscribe', () => {
  it('delivers events to subscribers for the matching runId', () => {
    const bus = new InMemoryRunEventBus();
    const sub = vi.fn();
    bus.subscribe('run-1', sub);
    bus.publish(modelCallStarted('run-1', 0));
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub.mock.calls[0]?.[0]).toMatchObject({
      type: 'model_call_started',
      runId: 'run-1',
    });
    bus.resetForTests();
  });

  it('does NOT deliver events to subscribers of a different runId', () => {
    const bus = new InMemoryRunEventBus();
    const subA = vi.fn();
    const subB = vi.fn();
    bus.subscribe('run-A', subA);
    bus.subscribe('run-B', subB);
    bus.publish(modelCallStarted('run-A'));
    expect(subA).toHaveBeenCalledTimes(1);
    expect(subB).not.toHaveBeenCalled();
    bus.resetForTests();
  });

  it('delivers each event to every subscriber on the run', () => {
    const bus = new InMemoryRunEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('run-1', a);
    bus.subscribe('run-1', b);
    bus.publish(modelCallStarted());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    bus.resetForTests();
  });

  it('unsubscribe removes the subscriber from future events', () => {
    const bus = new InMemoryRunEventBus();
    const sub = vi.fn();
    const unsubscribe = bus.subscribe('run-1', sub);
    bus.publish(modelCallStarted('run-1', 0));
    unsubscribe();
    bus.publish(modelCallStarted('run-1', 1));
    expect(sub).toHaveBeenCalledTimes(1);
    bus.resetForTests();
  });

  it('a subscriber that throws is dropped, others continue', () => {
    const bus = new InMemoryRunEventBus();
    const bad = vi.fn(() => {
      throw new Error('oops');
    });
    const good = vi.fn();
    bus.subscribe('run-1', bad);
    bus.subscribe('run-1', good);
    bus.publish(modelCallStarted());
    bus.publish(modelCallStarted('run-1', 1));
    // The thrower fires once, then is removed.
    expect(bad).toHaveBeenCalledTimes(1);
    // The good subscriber gets both.
    expect(good).toHaveBeenCalledTimes(2);
    bus.resetForTests();
  });
});

describe('InMemoryRunEventBus — late-join replay via snapshot()', () => {
  it('returns events already published for the run', () => {
    const bus = new InMemoryRunEventBus();
    bus.publish(modelCallStarted('run-1', 0));
    bus.publish(modelCallStarted('run-1', 1));
    bus.publish(modelCallStarted('run-2', 0));
    const snap = bus.snapshot('run-1');
    expect(snap).toHaveLength(2);
    expect(snap[0]?.data).toMatchObject({ turn: 0 });
    expect(snap[1]?.data).toMatchObject({ turn: 1 });
    bus.resetForTests();
  });

  it('returns an independent copy (caller can mutate without affecting the bus)', () => {
    const bus = new InMemoryRunEventBus();
    bus.publish(modelCallStarted());
    const snap = bus.snapshot('run-1');
    snap.length = 0;
    expect(bus.snapshot('run-1')).toHaveLength(1);
    bus.resetForTests();
  });

  it('returns empty array for an unknown run', () => {
    const bus = new InMemoryRunEventBus();
    expect(bus.snapshot('never-existed')).toEqual([]);
    bus.resetForTests();
  });
});

describe('InMemoryRunEventBus — terminal cleanup', () => {
  it('clears the buffer and subscribers some time after a terminal event', async () => {
    // Use a 10 ms cleanup window so the test stays fast.
    const bus = new InMemoryRunEventBus({ bufferCleanupMs: 10 });
    const sub = vi.fn();
    bus.subscribe('run-1', sub);
    bus.publish(modelCallStarted());
    bus.publish(runCompleted());

    // Terminal event was delivered before cleanup ran.
    expect(sub).toHaveBeenCalledTimes(2);
    expect(bus.snapshot('run-1')).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 30));
    expect(bus.snapshot('run-1')).toEqual([]);

    // New publish after cleanup creates a fresh buffer (no leftover state).
    bus.publish(modelCallStarted());
    expect(bus.snapshot('run-1')).toHaveLength(1);
    bus.resetForTests();
  });

  it('a non-terminal event does NOT schedule cleanup', async () => {
    const bus = new InMemoryRunEventBus({ bufferCleanupMs: 10 });
    bus.publish(modelCallStarted());
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.snapshot('run-1')).toHaveLength(1);
    bus.resetForTests();
  });

  it('multiple terminal events do not stack cleanup timers', async () => {
    const bus = new InMemoryRunEventBus({ bufferCleanupMs: 30 });
    bus.publish(runCompleted());
    // Republish a terminal a few ms later — implementation should clear
    // the prior timer + restart so the buffer is gone ~30 ms after the
    // LAST terminal, not earlier.
    await new Promise((r) => setTimeout(r, 5));
    bus.publish(runCompleted());
    await new Promise((r) => setTimeout(r, 20));
    expect(bus.snapshot('run-1')).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.snapshot('run-1')).toEqual([]);
    bus.resetForTests();
  });
});
