import { describe, expect, it } from "vitest";
import { createInFlightTracker } from "../../src/killswitch/inFlightPersists.js";

describe("createInFlightTracker", () => {
  it("drain() waits for a tracked promise that is still pending", async () => {
    const tracker = createInFlightTracker();
    let settled = false;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    tracker.track(
      gate.then(() => {
        settled = true;
      }),
    );

    const drainPromise = tracker.drain();

    // Give drain() every opportunity to resolve early if it were broken.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await drainPromise;
    expect(settled).toBe(true);
  });

  it("drain() resolves immediately when nothing is tracked", async () => {
    const tracker = createInFlightTracker();
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("drain() waits for ALL currently-tracked promises, not just the first", async () => {
    const tracker = createInFlightTracker();
    const order: string[] = [];

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    tracker.track(
      slowGate.then(() => {
        order.push("slow");
      }),
    );
    tracker.track(
      Promise.resolve().then(() => {
        order.push("fast");
      }),
    );

    const drainPromise = tracker.drain();
    releaseSlow();
    await drainPromise;

    expect(order).toEqual(["fast", "slow"]);
  });

  it("drain() does not reject even if a tracked promise rejects", async () => {
    const tracker = createInFlightTracker();
    tracker.track(Promise.reject(new Error("simulated persist failure")));

    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("a promise that already settled before drain() is called does not make drain() hang", async () => {
    const tracker = createInFlightTracker();
    tracker.track(Promise.resolve());

    // Let the microtask from track()'s own .finally() run, same as real usage
    // where settlement and drain() are not necessarily back-to-back.
    await Promise.resolve();

    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("a promise tracked AFTER drain() was called is not waited on by that call", async () => {
    const tracker = createInFlightTracker();
    const firstDrain = tracker.drain();
    await firstDrain; // resolves immediately, nothing was tracked yet

    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tracker.track(
      gate.then(() => {
        settled = true;
      }),
    );

    // A second, fresh drain() call DOES wait for it — only the earlier,
    // already-resolved drain() call is unaffected.
    const secondDrain = tracker.drain();
    release();
    await secondDrain;
    expect(settled).toBe(true);
  });
});
