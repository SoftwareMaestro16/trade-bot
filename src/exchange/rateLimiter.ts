/**
 * NFR-04: per-symbol REST sweeps (open interest, long/short ratio — Bybit has no
 * batch form for either) must not burst against the exchange. Bybit's documented
 * IP-level limit is 600 requests / 5s, with a 403 + >=10min lockout on breach
 * (RISK-REGISTER.md FM-19) — a lockout mid-sweep would itself become the gap that
 * breaks Phase 1's "two weeks without gaps" exit criterion.
 *
 * Deliberately simple: a fixed minimum spacing between calls, serialized through a
 * promise chain. No burst allowance, no token bucket — Phase 1 has no low-latency
 * requirement, so the simplest thing that cannot burst is the right amount of
 * engineering here. A true token-bucket with per-endpoint budgets (RSK-58) belongs
 * to execution/, where bursts under contention actually matter.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(minIntervalMs: number) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError(`minIntervalMs must be a non-negative finite number, got ${minIntervalMs}`);
    }
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * Runs `fn` no sooner than `minIntervalMs` after the previously scheduled call
   * SETTLED (end-to-start spacing, not start-to-start — strictly more conservative
   * than the name suggests, never less). The queue advances whether `fn` resolves
   * or rejects — a single failed call (a transient network error, say) must not
   * deadlock every call queued after it, which is exactly what would happen if the
   * release only ran on success.
   *
   * `fn` is invoked via `Promise.resolve().then(fn)`, not called bare. A bare
   * `fn()` call is NOT equivalent: if `fn` throws synchronously (e.g. a guard
   * clause before its first `await`) or returns a non-native thenable without a
   * `.finally` method, `fn()` itself throws before ever returning a promise to
   * attach `.finally()` to — `releaseNext` is never scheduled, and the queue
   * deadlocks forever for every call after it. Routing the call through
   * `Promise.resolve().then(...)` guarantees `fn` only ever runs inside a promise
   * callback (a sync throw becomes a rejection, not an exception) and normalizes
   * whatever it returns into a real, `.finally`-bearing Promise.
   */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const runAfter = this.chain;
    let releaseNext: () => void;
    this.chain = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });

    return runAfter.then(() =>
      Promise.resolve()
        .then(fn)
        .finally(() => {
          setTimeout(releaseNext, this.minIntervalMs);
        }),
    );
  }
}
