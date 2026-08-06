import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../../src/exchange/rateLimiter.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter", () => {
  it("serializes calls: the second call does not start until the first has resolved", async () => {
    const limiter = new RateLimiter(100);
    const order: string[] = [];

    const p1 = limiter.schedule(async () => {
      order.push("first-start");
      await Promise.resolve();
      order.push("first-end");
    });
    const p2 = limiter.schedule(async () => {
      order.push("second-start");
    });

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("waits at least minIntervalMs between the end of one call and the start of the next", async () => {
    const limiter = new RateLimiter(100);
    const timestamps: number[] = [];

    const p1 = limiter.schedule(async () => {
      timestamps.push(Date.now());
    });
    const p2 = limiter.schedule(async () => {
      timestamps.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(timestamps).toHaveLength(1); // second call must not have started yet

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([p1, p2]);

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(100);
  });

  it("does not deadlock the queue when a scheduled call rejects (the bug caught before writing this test)", async () => {
    const limiter = new RateLimiter(10);

    const p1 = limiter.schedule(async () => {
      throw new Error("transient failure");
    });
    // Attach the rejection assertion in the same tick p1 is created — otherwise
    // Node flags it as an unhandled rejection during the gap before this runs.
    const p1Assertion = expect(p1).rejects.toThrow("transient failure");
    const p2 = limiter.schedule(async () => "second call still runs");

    await vi.runAllTimersAsync();

    await p1Assertion;
    await expect(p2).resolves.toBe("second call still runs");
  });

  it("propagates the resolved value of fn to the caller", async () => {
    const limiter = new RateLimiter(0);
    const result = await limiter.schedule(async () => 42);
    expect(result).toBe(42);
  });

  it("rejects construction with a negative or non-finite interval", () => {
    expect(() => new RateLimiter(-1)).toThrow(RangeError);
    expect(() => new RateLimiter(Number.NaN)).toThrow(RangeError);
    expect(() => new RateLimiter(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
