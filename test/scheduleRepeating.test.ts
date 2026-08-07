import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleRepeating } from "../src/scheduleRepeating.js";

// Fake timers throughout, same as notify/dailySchedule.test.ts: scheduleRepeating
// has no real I/O of its own (unlike notify/healthcheck.test.ts's startHeartbeat,
// which drives a real fetch/undici round-trip fake timers' "Async" helpers can't
// bound-await) — every `fn` here is a plain in-memory callback, so fake timers are
// both safe and much faster than waiting out real intervals.
describe("scheduleRepeating", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs fn immediately on start, without waiting a full interval first", async () => {
    let calls = 0;
    const task = scheduleRepeating(
      "test",
      async () => {
        calls++;
      },
      1000,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    void task.stop();
  });

  it("waits intervalMs after a run COMPLETES before starting the next — never wall-clock ticks", async () => {
    const starts: number[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;

    const task = scheduleRepeating(
      "test",
      async () => {
        callCount++;
        starts.push(callCount);
        if (callCount === 1) {
          await firstGate; // hold the first cycle open well past intervalMs
        }
      },
      100,
    );

    await vi.advanceTimersByTimeAsync(0); // first cycle starts, then hangs on firstGate
    expect(starts).toEqual([1]);

    // Advance well past intervalMs while the first cycle is still in flight —
    // if scheduling were wall-clock-based, a second call would fire here.
    // Being timer-based (setTimeout scheduled only after fn() resolves), it must not.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(starts).toEqual([1]);

    resolveFirst(); // let the first cycle finish
    await vi.advanceTimersByTimeAsync(0); // let the .then chain settle and schedule the next timer
    expect(starts).toEqual([1]); // still not started — intervalMs hasn't elapsed since completion yet

    await vi.advanceTimersByTimeAsync(100); // now the post-completion interval elapses
    expect(starts).toEqual([1, 2]);

    void task.stop();
  });

  it("a failure in fn is swallowed and does NOT stop the schedule", async () => {
    let callCount = 0;
    const task = scheduleRepeating(
      "test",
      async () => {
        callCount++;
        throw new Error("cycle boom");
      },
      50,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(callCount).toBe(2); // schedule kept going despite the throw

    await vi.advanceTimersByTimeAsync(50);
    expect(callCount).toBe(3);

    void task.stop();
  });

  it("stop() prevents any further tick, even one already scheduled", async () => {
    let callCount = 0;
    const task = scheduleRepeating(
      "test",
      async () => {
        callCount++;
      },
      50,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    await task.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(1); // unchanged after stop, despite advancing well past the interval
  });

  it("stop() waits for an in-flight fn() call to finish before resolving", async () => {
    let resolveFn!: () => void;
    const fnGate = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    let fnStarted = false;

    const task = scheduleRepeating(
      "test",
      async () => {
        fnStarted = true; // set BEFORE awaiting the gate, so the test can detect "fn is genuinely in flight"
        await fnGate;
      },
      1000,
    );

    await vi.advanceTimersByTimeAsync(0); // first tick starts and hangs on fnGate
    expect(fnStarted).toBe(true);

    let stopResolved = false;
    const stopPromise = task.stop().then(() => {
      stopResolved = true;
    });

    // Flush pending microtasks without advancing real firing time: if stop()
    // resolved without actually waiting for the in-flight fn(), stopResolved
    // would already be true here.
    await vi.advanceTimersByTimeAsync(0);
    expect(stopResolved).toBe(false); // fn() is still hanging on fnGate

    resolveFn();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it("stop() called while a cycle is in flight also cancels the tick it would otherwise have scheduled next", async () => {
    let callCount = 0;
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const task = scheduleRepeating(
      "test",
      async () => {
        callCount++;
        if (callCount === 1) await firstGate;
      },
      50,
    );

    await vi.advanceTimersByTimeAsync(0); // first cycle starts, hangs on firstGate
    expect(callCount).toBe(1);

    const stopPromise = task.stop(); // stopped=true set synchronously, before the first cycle even finishes
    resolveFirst(); // let the in-flight cycle finish
    await stopPromise;

    await vi.advanceTimersByTimeAsync(10_000); // well past intervalMs, several times over
    expect(callCount).toBe(1); // no second tick was ever scheduled, because `stopped` was already true when fn() resolved
  });
});
