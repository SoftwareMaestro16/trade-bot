/**
 * Tracks fire-and-forget async calls so a shutdown path can wait for every
 * one still running before tearing down a resource they depend on (a DB
 * pool, here).
 *
 * Exists specifically for killswitch-listener.ts's `applyAndPersist`: every
 * call site there (file-flag detection, /stop, /flatten, /resume) invokes it
 * fire-and-forget, deliberately, so a slow persist can never block command
 * handling. Before this module existed those were bare `void
 * applyAndPersist(...)` calls, meaning the promise had no caller left to
 * await it at all — including `shutdown()`, which previously assumed `await
 * telegramPolling.stop()` was enough to guarantee no persist was still in
 * flight. It wasn't: `telegramPolling`'s own loop only awaits up through the
 * synchronous `onCommand` dispatch (see telegramPolling.ts's `pollOnce`), not
 * whatever detached promise that dispatch kicked off. A `/stop` or `/flatten`
 * landing right at shutdown could have its `saveHaltState` write (and its
 * Telegram alert) silently abandoned mid-flight when `db.destroy()` ran
 * anyway — no error, no log line, no trace in journalctl. Every one of those
 * call sites now instead does `inFlightPersists.track(applyAndPersist(...))`,
 * so shutdown() has something to actually drain.
 *
 * Same shape as collector.ts's `scheduleRepeating` `inFlight` tracking (see
 * that file's own doc comment for the identical reasoning), generalized to N
 * concurrent calls instead of one at a time: `applyAndPersist`'s own
 * `createPersistQueue` already serializes the underlying DB writes, so this
 * only needs to know when the LAST caller-side promise has settled, not
 * enforce any ordering itself.
 */
export interface InFlightTracker {
  /** Registers `p` as in-flight. Stops tracking it once it settles, whichever way. */
  track: (p: Promise<void>) => void;
  /**
   * Resolves once every promise tracked AT THE TIME THIS IS CALLED has
   * settled — fulfilled or rejected, never itself rejecting regardless of
   * how any of them settled. That last part matters here specifically:
   * `applyAndPersist` is documented to never reject, but `drain()` must not
   * become a new way for shutdown to hang or throw if that invariant is ever
   * violated by a future edit — an unhandled rejection out of `shutdown()`
   * (invoked as bare `void shutdown(signal)` from the signal handler) would
   * crash the process before `process.exit(0)` runs, taking down both Level-1
   * paths over the exact kind of edge case this tracker exists to make safe.
   *
   * Deliberately NOT a snapshot-and-loop-until-empty: a promise tracked AFTER
   * `drain()` is called (e.g. a new command arriving during the drain itself)
   * is not waited on. Callers here stop feeding new work into this tracker
   * (fileFlagWatcher.stop() / telegramPolling.stop()) before calling drain(),
   * so that's not a real gap for this file's usage — documented here so a
   * future caller doesn't assume otherwise.
   */
  drain: () => Promise<void>;
}

export function createInFlightTracker(): InFlightTracker {
  const pending = new Set<Promise<void>>();

  return {
    track(p) {
      pending.add(p);
      // Two-armed `.then`, not `.finally`: `.finally(cb)`'s OWN returned
      // promise re-rejects whenever `p` does (it only runs `cb` as a
      // side-effect, then re-throws) — `void p.finally(...)` would leave that
      // derived promise itself unhandled, which is exactly the failure mode
      // this whole module exists to avoid elsewhere. Both arms below just
      // remove `p` from the set and return normally either way, so this
      // never produces a promise that can go unhandled.
      void p.then(
        () => pending.delete(p),
        () => pending.delete(p),
      );
    },
    drain() {
      return Promise.allSettled(pending).then(() => undefined);
    },
  };
}
