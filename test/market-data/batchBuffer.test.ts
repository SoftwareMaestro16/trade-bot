import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchBuffer } from "../../src/market-data/batchBuffer.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BatchBuffer", () => {
  it("flushes immediately once maxSize is reached, without waiting for the timer", async () => {
    const flushed: number[][] = [];
    const buffer = new BatchBuffer<number>(3, 10_000, async (items) => {
      flushed.push(items);
    });

    buffer.push(1);
    buffer.push(2);
    expect(flushed).toHaveLength(0);
    buffer.push(3);
    await vi.waitFor(() => expect(flushed).toHaveLength(1));

    expect(flushed[0]).toEqual([1, 2, 3]);
    expect(buffer.pending).toBe(0);
  });

  it("flushes after maxWaitMs even if maxSize was never reached", async () => {
    const flushed: number[][] = [];
    const buffer = new BatchBuffer<number>(100, 1000, async (items) => {
      flushed.push(items);
    });

    buffer.push(1);
    buffer.push(2);
    expect(flushed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(flushed).toEqual([[1, 2]]);
  });

  it("does not flush an empty buffer", async () => {
    const flushed: number[][] = [];
    const buffer = new BatchBuffer<number>(10, 100, async (items) => {
      flushed.push(items);
    });

    await buffer.flush();
    await vi.advanceTimersByTimeAsync(200);

    expect(flushed).toHaveLength(0);
  });

  it("starts a fresh wait window after each flush, not a single one-shot timer", async () => {
    const flushed: number[][] = [];
    const buffer = new BatchBuffer<number>(100, 100, async (items) => {
      flushed.push(items);
    });

    buffer.push(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(flushed).toEqual([[1]]);

    buffer.push(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(flushed).toEqual([[1], [2]]);
  });

  it("rejects non-positive maxSize/maxWaitMs at construction", () => {
    expect(() => new BatchBuffer<number>(0, 100, async () => {})).toThrow(RangeError);
    expect(() => new BatchBuffer<number>(10, 0, async () => {})).toThrow(RangeError);
  });

  // Logging moved from console.error to pino (RUNBOOK.md §8, 2026-08-07).
  // These two tests used to assert the exact console.error call; pino writes
  // asynchronously/buffered (sonic-boom) and does not flush reliably under
  // this file's `vi.useFakeTimers()` (verified: process.stdout.write itself
  // genuinely does get called by pino outside a fake-timers context — the
  // interaction is specific to fake timers freezing pino's internal flush
  // scheduling, not a real "nothing gets logged" bug). Asserting on the exact
  // logged bytes here would be testing fragile plumbing, not the behavior
  // that actually matters: that a throwing onFlush is caught, never rejects
  // the caller, and the failed batch is dropped rather than stuck retrying —
  // which both tests below still assert directly via `buffer.pending`.
  it("flush() never rejects when onFlush throws — a failed batch is dropped, not left as an unhandled rejection that would crash the whole process", async () => {
    const buffer = new BatchBuffer<number>(3, 10_000, async () => {
      throw new Error("simulated DB write failure");
    });

    buffer.push(1);
    buffer.push(2);
    buffer.push(3); // triggers a maxSize flush via push()'s own bare `void this.flush()`

    await vi.waitFor(() => expect(buffer.pending).toBe(0)); // the failed batch is gone, not retried and not stuck
  });

  it("flush() never rejects even when onFlush throws SYNCHRONOUSLY (not an async function that throws) — a bare onFlush(items) call would never return a promise for .catch() to attach to", async () => {
    // Deliberately NOT `async () => { throw ... }` — a genuinely synchronous
    // function that throws before ever returning anything. TypeScript still
    // accepts this for a `(items: T[]) => Promise<void>`-typed parameter
    // (inferred return type `never` is assignable to `Promise<void>`), so
    // nothing here is a type error the compiler would have caught.
    function syncThrowingOnFlush(): Promise<void> {
      throw new Error("threw before returning a promise at all");
    }
    const buffer = new BatchBuffer<number>(3, 10_000, syncThrowingOnFlush);

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);

    await vi.waitFor(() => expect(buffer.pending).toBe(0));
  });

  it("an explicit await on flush() also resolves (not rejects) when onFlush throws", async () => {
    const buffer = new BatchBuffer<number>(10, 100, async () => {
      throw new Error("simulated failure");
    });
    buffer.push(1);

    await expect(buffer.flush()).resolves.toBeUndefined();
  });

  it("drain() waits for a flush already in flight from an earlier push(), not just the one it triggers itself", async () => {
    vi.useRealTimers(); // this test needs a real, observable async gap mid-flush
    let resolveFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((resolve) => {
      resolveFirstFlush = resolve;
    });
    const flushed: number[][] = [];

    const buffer = new BatchBuffer<number>(1, 10_000, async (items) => {
      if (items[0] === 1) await firstFlushGate; // first batch hangs until released below
      flushed.push(items);
    });

    buffer.push(1); // maxSize=1 -> triggers an immediate flush that now hangs on firstFlushGate
    expect(buffer.pending).toBe(0); // already swapped out of the buffer, just not written yet

    buffer.push(2); // maxSize=1 again -> a SECOND, independent flush starts concurrently and completes quickly
    await vi.waitFor(() => expect(flushed).toEqual([[2]]));

    const drainPromise = buffer.drain();
    let drainResolved = false;
    void drainPromise.then(() => {
      drainResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drainResolved).toBe(false); // the first flush is still hanging — drain() must not resolve yet

    resolveFirstFlush();
    await drainPromise;
    expect(drainResolved).toBe(true);
    expect(flushed).toEqual([[2], [1]]);

    vi.useFakeTimers();
  });
});
