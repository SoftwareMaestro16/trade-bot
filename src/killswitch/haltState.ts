/**
 * RSK-52 (RISK-REGISTER.md, derived from FM-34): the kill switch is two
 * independent flags, not one generic stop — HALT_NEW blocks new position
 * entries, FLATTEN_ALL means "close everything now." The reconciler and every
 * closing path are excluded from HALT_NEW entirely; `canCloseExistingPosition`
 * below is the structural expression of that exclusion, not a convenience
 * helper. (Not to be confused with SRS.md's own RR-52, an unrelated WebSocket
 * schema-validation requirement — the two share a number by coincidence, not
 * a shared source.)
 *
 * This module is pure state and transitions only — no filesystem, no DB, no
 * network. Persistence across restarts (RSK-52's requirement that halt state
 * survive a crash) is a separate integration task layered on top of this one.
 */
export interface HaltState {
  haltNew: boolean;
  flattenAll: boolean;
  reason: string | null;
  setBy: string | null; // who set it: "manual" | "risk:DRAWDOWN_EXCEEDED" | etc — just a source-identifier string
  setAtMs: number | null;
}

export const CLEARED_STATE: HaltState = {
  haltNew: false,
  flattenAll: false,
  reason: null,
  setBy: null,
  setAtMs: null,
};

/**
 * RR-52: raising HALT_NEW must never downgrade an already-active FLATTEN_ALL.
 * FLATTEN_ALL is the strictly stronger state (`applyFlattenAll` always sets
 * both flags together), so a later, lesser halt request folds in without
 * erasing it.
 */
export function applyHaltNew(current: HaltState, reason: string, setBy: string, nowMs: number): HaltState {
  return {
    haltNew: true,
    flattenAll: current.flattenAll,
    reason,
    setBy,
    setAtMs: nowMs,
  };
}

/**
 * RR-52: FLATTEN_ALL logically includes HALT_NEW — "close everything" cannot
 * coexist with still accepting new entries — so both flags are set together
 * here rather than relying on every caller to also call `applyHaltNew`.
 */
export function applyFlattenAll(current: HaltState, reason: string, setBy: string, nowMs: number): HaltState {
  return {
    haltNew: true,
    flattenAll: true,
    reason,
    setBy,
    setAtMs: nowMs,
  };
}

/**
 * RR-52: a halt "снимается только явной командой с записью кто/когда/почему"
 * — lifting it requires an explicit, attributed command. Obtaining that human
 * confirmation is the CALLER's responsibility, done BEFORE calling this
 * function; this function cannot verify a human actually approved anything,
 * so it enforces only what it can from here: `confirmedBy` must be non-empty.
 * An empty or whitespace-only value throws rather than being silently
 * accepted as "cleared by no one."
 *
 * `nowMs` is accepted for the same (current, ..., nowMs) call shape as
 * `applyHaltNew`/`applyFlattenAll`, so a future audit-log integration can
 * timestamp the clear event without this signature changing — it is not used
 * to build the returned state itself, since `setBy`/`setAtMs` describe an
 * active halt's source, and a cleared state has none.
 */
export function clearHalt(current: HaltState, confirmedBy: string, nowMs: number): HaltState {
  if (confirmedBy.trim().length === 0) {
    throw new Error(
      "clearHalt requires a non-empty confirmedBy — clearing a halt must be attributable to a specific operator (RR-52).",
    );
  }
  void current;
  void nowMs;
  return { ...CLEARED_STATE };
}

/**
 * RR-52: blocked by either flag. FLATTEN_ALL implies HALT_NEW by construction
 * (`applyFlattenAll`), but both are checked explicitly rather than trusting
 * that invariant to hold for every possible `HaltState` value — e.g. one
 * reconstructed from persisted storage by the future integration layer
 * (RR-52's "переживает рестарт").
 */
export function canEnterNewPosition(state: HaltState): boolean {
  return !state.haltNew && !state.flattenAll;
}

/**
 * RR-52: closing an existing position — including everything the reconciler
 * does — is structurally excluded from HALT_NEW. This always returns true,
 * even when `flattenAll` is true: FLATTEN_ALL's entire point is to force
 * closes, not merely permit them, so closing can never be the thing a halt
 * blocks. An unconditional `true` (instead of e.g. `!state.someFlag`) makes
 * that a structural guarantee rather than a convention a future edit could
 * quietly break.
 */
export function canCloseExistingPosition(state: HaltState): boolean {
  void state; // deliberately unexamined — see doc comment above.
  return true;
}
