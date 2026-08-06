import { logger as rootLogger } from "../logger.js";

/**
 * Size/time-based write buffer. Built for collectLiquidations.ts: liquidation
 * cascades (RISK-REGISTER.md FM-25/FM-28) can burst well above the calm-window
 * baseline, and a naive one-INSERT-per-event writer is exactly the wrong shape
 * for that — this flushes on whichever bound is hit first, so quiet periods still
 * write promptly (maxWaitMs) and bursts don't turn into thousands of tiny inserts.
 */
const logger = rootLogger.child({ module: "batchBuffer" });

export class BatchBuffer<T> {
  private readonly maxSize: number;
  private readonly maxWaitMs: number;
  private readonly onFlush: (items: T[]) => Promise<void>;
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Every flush's settle-promise (which itself never rejects, see flush()) lives
  // here until it settles. Needed because push() can trigger several overlapping
  // maxSize-flushes back to back — drain() must wait for ALL of them, not just
  // whichever one it happens to trigger itself.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(maxSize: number, maxWaitMs: number, onFlush: (items: T[]) => Promise<void>) {
    if (maxSize <= 0) throw new RangeError(`maxSize must be positive, got ${maxSize}`);
    if (maxWaitMs <= 0) throw new RangeError(`maxWaitMs must be positive, got ${maxWaitMs}`);
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.onFlush = onFlush;
  }

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.maxSize) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.maxWaitMs);
    }
  }

  /**
   * Swaps out the current buffer and writes it. NEVER rejects: both `push()`'s
   * maxSize branch and the idle timer call this as `void this.flush()`, with
   * nothing to attach a `.catch()` to — before this fix, a rejecting `onFlush`
   * (e.g. a transient DB hiccup) was an unhandled promise rejection, which is an
   * uncaught exception in Node by default and killed the ENTIRE collector
   * process, not just the liquidation stream. A dropped batch of liquidation
   * events is real but bounded data loss (nothing in risk/ or execution/ reads
   * this table to gate a trading decision); crashing every other scheduled
   * collector over it is a strictly worse outcome, so failures are caught,
   * logged loudly, and the batch is dropped rather than silently retried forever.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;
    const items = this.buffer;
    this.buffer = [];

    // onFlush invoked via Promise.resolve().then(...), not called bare: a
    // bare this.onFlush(items) that throws SYNCHRONOUSLY never returns a
    // promise for .catch() to attach to — since flush() is itself async,
    // that throw would be caught by flush()'s own implicit promise wrapping
    // and surface as flush() rejecting anyway, completely bypassing this
    // "never rejects" guarantee for exactly the callers (push()'s bare `void
    // this.flush()`) it exists to protect. Same trap, same fix shape, as
    // exchange/rateLimiter.ts and killswitch/persistQueue.ts.
    const settled = Promise.resolve()
      .then(() => this.onFlush(items))
      .catch((error: unknown) => {
        logger.error({ err: error, itemCount: items.length }, "flush failed, items dropped");
      });
    this.inFlight.add(settled);
    try {
      await settled;
    } finally {
      this.inFlight.delete(settled);
    }
  }

  /**
   * Flushes whatever is currently buffered AND waits for every flush already in
   * flight from an earlier push() — not just the one this call itself triggers.
   * A burst can fire several overlapping maxSize-flushes; `flush()` alone only
   * awaits its own attempt. Callers must use `drain()`, not `flush()`, before
   * tearing down any resource `onFlush` depends on (e.g. a DB pool) — otherwise
   * an earlier, still-in-flight batch can be aborted mid-write.
   */
  async drain(): Promise<void> {
    await this.flush();
    await Promise.all(this.inFlight);
  }

  /** Items currently buffered, not yet flushed. For tests/observability only. */
  get pending(): number {
    return this.buffer.length;
  }
}
