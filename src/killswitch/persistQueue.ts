/**
 * RSK-52 (RISK-REGISTER.md, derived from FM-34): `haltStatePersistence.ts`'s
 * `saveHaltState` is a plain `UPDATE ... WHERE id = 1` with no version/CAS
 * column, no transaction, no ordering guarantee relative to another call —
 * each is an independent network round-trip. Two triggers arriving close
 * together (a file-flag detection racing a Telegram `/flatten`, say — a
 * plausible "hit every kill switch at once" reaction during a real incident)
 * have no guarantee their UPDATEs commit in the order they were issued: the
 * earlier, weaker write completing AFTER the later, stronger one would
 * silently leave the DB holding the weaker state. On restart, `loadHaltState`
 * trusts the DB as ground truth, so that inversion would silently downgrade
 * or erase the real last intent — this queue exists specifically to make
 * that impossible for calls enqueued through the SAME queue instance.
 *
 * Same queue-with-release-even-on-failure shape as exchange/rateLimiter.ts,
 * not reused from there: this queue has no minimum spacing (a persist must
 * never be artificially delayed), only ordering, and killswitch/ has no
 * reason to depend on exchange/ for an incidental resemblance.
 */
export function createPersistQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const runAfter = tail;
    let release: () => void;
    tail = new Promise((resolve) => {
      release = resolve;
    });

    // fn invoked via Promise.resolve().then(fn), not called bare: a bare
    // fn() that throws synchronously would never return a promise to attach
    // .finally() to, and release() would never run — wedging the queue for
    // every call enqueued after it. Same reasoning as rateLimiter.ts's fix.
    return runAfter.then(() => Promise.resolve().then(fn).finally(release));
  };
}
