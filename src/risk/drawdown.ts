import Big from "big.js";
import { allow, deny } from "./types.js";
import type { VetoResult } from "./types.js";

const MAX_DRAWDOWN_FRACTION = new Big("0.03"); // PARAMS-CONSERVATIVE.md §8

/**
 * RR-40 (SRS.md), PARAMS-CONSERVATIVE.md §8: drawdown is measured from total
 * account equity (both legs' unrealized P&L included, never one leg alone —
 * the legs move in opposite directions, so a single-leg view is meaningless).
 *
 * Pure computation only: peak tracking (RR-41/RR-42 — persisted across
 * restarts, never auto-reset) is state management the caller owns, not this
 * function's job. If `currentEquity` exceeds `peakEquity`, that itself means
 * the caller has not yet updated its stored peak; this function reports zero
 * drawdown rather than a negative one, but does not correct the caller's state.
 *
 * `peakEquity <= 0` is a different situation from `currentEquity <= 0`:
 * equityEngine.ts's doc comment explains that `currentEquity` legitimately
 * reaches zero/negative at liquidation-magnitude moves, so that side is never
 * guarded here. But a *peak* is, by construction, the highest equity value
 * the caller has ever sampled and stored (RR-41/RR-42) — a zero-or-negative
 * peak means the peak tracker itself was never initialized with a real
 * reading, or was corrupted, not that the account is having an ordinary bad
 * day. Left unguarded, this is worse than `checkLeverage`'s zero-equity case:
 * it does not just throw an uncontrolled Big.js error, it can silently
 * flip the drawdown fraction negative (peak and current both underwater,
 * current worse) so a deep, ongoing loss reads as "no drawdown" and the
 * RR-40 veto never fires — exactly backwards. So, like `checkLeverage`'s
 * `totalEquity <= 0` guard, this fails closed with a documented `RangeError`
 * before any division happens, rather than leaving the caller to hit
 * Big.js's own division-by-zero error or a silently wrong sign.
 */
export function computeDrawdown(currentEquity: Big, peakEquity: Big): Big {
  if (peakEquity.lte(0)) {
    throw new RangeError(`peakEquity must be positive, got ${peakEquity.toString()}`);
  }
  if (currentEquity.gte(peakEquity)) {
    return new Big(0);
  }
  return peakEquity.minus(currentEquity).div(peakEquity);
}

/**
 * PARAMS-CONSERVATIVE.md §8: 3% threshold (stricter than the brief's 5%
 * starting point). Boundary is inclusive-deny (`>=`) — "лучше закрыться зря,
 * чем один раз не закрыться вовремя" (бриф, раздел 7): the sub-3% margin was
 * spent on cutting it closer than the brief itself asked for.
 */
export function checkDrawdown(currentEquity: Big, peakEquity: Big): VetoResult {
  const drawdown = computeDrawdown(currentEquity, peakEquity);
  if (drawdown.gte(MAX_DRAWDOWN_FRACTION)) {
    return deny(
      "DRAWDOWN_EXCEEDED",
      `Drawdown ${drawdown.toString()} from peak equity ${peakEquity.toString()} reaches the ${MAX_DRAWDOWN_FRACTION.toString()} threshold (PARAMS-CONSERVATIVE.md §8).`,
    );
  }
  return allow();
}
