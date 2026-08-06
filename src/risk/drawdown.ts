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
 */
export function computeDrawdown(currentEquity: Big, peakEquity: Big): Big {
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
