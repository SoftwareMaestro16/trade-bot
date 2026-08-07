import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msUntilNextUtcTime, scheduleDailyAt } from "../../src/notify/dailySchedule.js";

describe("msUntilNextUtcTime", () => {
  it("returns the delay until later today when the target time hasn't passed yet", () => {
    const now = new Date("2026-08-06T08:00:00Z");
    const ms = msUntilNextUtcTime(9, 0, now); // 09:00 UTC, 1h later
    expect(ms).toBe(60 * 60 * 1000);
  });

  it("rolls over to tomorrow when the target time has already passed today", () => {
    const now = new Date("2026-08-06T10:00:00Z");
    const ms = msUntilNextUtcTime(9, 0, now); // 09:00 already passed -> tomorrow 09:00
    expect(ms).toBe(23 * 60 * 60 * 1000);
  });

  it("rolls over to tomorrow, not fires immediately, when now is exactly the target time", () => {
    const now = new Date("2026-08-06T09:00:00Z");
    const ms = msUntilNextUtcTime(9, 0, now);
    expect(ms).toBe(24 * 60 * 60 * 1000);
  });

  it("rejects an out-of-range hour or minute", () => {
    const now = new Date("2026-08-06T08:00:00Z");
    expect(() => msUntilNextUtcTime(24, 0, now)).toThrow(RangeError);
    expect(() => msUntilNextUtcTime(-1, 0, now)).toThrow(RangeError);
    expect(() => msUntilNextUtcTime(9, 60, now)).toThrow(RangeError);
  });
});

describe("scheduleDailyAt", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires at each of multiple configured hours independently", async () => {
    const fired: number[] = [];
    vi.setSystemTime(new Date("2026-08-06T00:00:00Z"));

    const task = scheduleDailyAt([9, 17], 0, async () => {
      fired.push(new Date().getUTCHours());
    });

    await vi.advanceTimersByTimeAsync(9 * 60 * 60 * 1000);
    expect(fired).toEqual([9]);

    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000); // now at 17:00
    expect(fired).toEqual([9, 17]);

    void task.stop();
  });

  it("reschedules for the next day after firing", async () => {
    const fired: Date[] = [];
    vi.setSystemTime(new Date("2026-08-06T08:59:00Z"));

    const task = scheduleDailyAt([9], 0, async () => {
      fired.push(new Date());
    });

    await vi.advanceTimersByTimeAsync(60 * 1000); // reaches 09:00 today
    expect(fired).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // one full day later
    expect(fired).toHaveLength(2);

    void task.stop();
  });

  it("keeps firing on schedule even if fn throws", async () => {
    let callCount = 0;
    vi.setSystemTime(new Date("2026-08-06T08:59:00Z"));

    const task = scheduleDailyAt([9], 0, async () => {
      callCount++;
      throw new Error("digest send failed");
    });

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(callCount).toBe(2);

    void task.stop();
  });

  it("stop() prevents further firings", async () => {
    let callCount = 0;
    vi.setSystemTime(new Date("2026-08-06T08:59:00Z"));

    const task = scheduleDailyAt([9], 0, async () => {
      callCount++;
    });

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(callCount).toBe(1);

    void task.stop();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(callCount).toBe(1); // unchanged after stop
  });

  it("stop() waits for an in-flight fn() call to finish before resolving", async () => {
    let resolveFn!: () => void;
    const fnGate = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    let fnStarted = false;
    vi.setSystemTime(new Date("2026-08-06T08:59:00Z"));

    const task = scheduleDailyAt([9], 0, async () => {
      fnStarted = true; // set BEFORE awaiting the gate, so the test can detect "fn is genuinely in flight"
      await fnGate;
    });

    await vi.advanceTimersByTimeAsync(60 * 1000); // reaches 09:00 -> fn() starts and hangs on fnGate
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
});
