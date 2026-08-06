import type Big from "big.js";
import { r8hToApr } from "../market-data/normalizeFunding.js";

/**
 * RSK-29 (RISK-REGISTER.md): "годовая доходность одним голым числом запрещена" —
 * three named fields, always together, because they answer different questions:
 * yield relative to the one leg funding is actually paid on, relative to the
 * combined two-leg notional, and relative to capital actually deployed. Collapsing
 * these into one number is exactly the mistake FM-07 documents (a headline 21.9%
 * figure quietly meant three different, much smaller things depending on context).
 */
export interface CandidateYield {
  yieldOnLegNotional: Big;
  yieldOnGrossNotional: Big;
  yieldOnEquity: Big;
}

/**
 * `legNotional` is the perp leg's notional (funding is paid on `positionValue`,
 * i.e. one leg — RISK-REGISTER.md FM-41). `totalEquity` is the account's total
 * equity, not just capital allocated to this candidate.
 */
export function computeCandidateYield(r8h: Big, legNotional: Big, totalEquity: Big): CandidateYield {
  const yieldOnLegNotional = r8hToApr(r8h);
  const yieldOnGrossNotional = yieldOnLegNotional.div(2); // gross = both legs = 2x one leg's notional
  const yieldOnEquity = yieldOnLegNotional.times(legNotional).div(totalEquity);
  return { yieldOnLegNotional, yieldOnGrossNotional, yieldOnEquity };
}

export interface RankedCandidate {
  symbol: string;
  yield: CandidateYield;
}

/**
 * RSK-29: risk/'s thresholds compare against `yieldOnEquity` specifically — this
 * function ranks by that same field so the ordering strategy/ proposes is the
 * ordering risk/ will actually judge, not a headline-yield ordering that risk/
 * would silently re-sort. Filtering/vetoing is NOT this function's job — every
 * veto (entry threshold, liquidity, leverage, ...) lives in risk/, this only sorts.
 */
export function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.yield.yieldOnEquity.gt(b.yield.yieldOnEquity)) return -1;
    if (a.yield.yieldOnEquity.lt(b.yield.yieldOnEquity)) return 1;
    return 0;
  });
}
