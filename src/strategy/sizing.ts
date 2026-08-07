import Big from "big.js";

const DEFAULT_MAX_RESIDUAL_DELTA = new Big("0.005"); // RISK-REGISTER.md FM-12

export interface SizingInput {
  targetNotional: Big;
  markPrice: Big;
  perpQtyStep: Big;
  maxResidualDeltaFraction?: Big;
}

export type SizingOutcome =
  | { allowed: true; perpQty: Big; spotQty: Big; residualDeltaFraction: Big }
  | { allowed: false; code: string; reason: string };

/**
 * RSK-07/RSK-08 (SRS.md), RISK-REGISTER.md FM-12: perp is sized FIRST, always
 * rounded DOWN to its qtyStep (never up — a short larger than the spot hedge is
 * a naked short, the exact failure this ordering prevents). Spot is then sized
 * to match the perp quantity exactly (1:1) — this function does not handle
 * contract multipliers (1000PEPE-style symbols, RSK-13); that belongs to the
 * curated `symbol_pairs` table planned for execution/, out of scope here.
 *
 * The residual-delta bound is the STRUCTURAL worst case for this step size
 * against this notional — `(qtyStep/2 * price) / notional` — not the
 * particular truncation this call happened to produce, per RISK-REGISTER.md's
 * exact formula. A notional that truncates to zero loss on this call can still
 * be vetoed, because the next poll's price will truncate differently.
 *
 * `targetNotional`, `markPrice`, and `perpQtyStep` must all be strictly
 * positive, checked explicitly up front. Each one divides or multiplies into
 * `residualDeltaFraction`: a zero `markPrice` or `perpQtyStep` zeroes the
 * whole fraction (0 is never `>` a positive threshold, so the FM-12 guard
 * below is silently defeated), and a non-positive `targetNotional` either
 * zeroes it the same way or flips its sign (same effect — `.gt()` still never
 * fires). Either way execution would otherwise fall through to the unguarded
 * `targetNotional.div(markPrice)` / `rawQty.div(perpQtyStep)` divisions below
 * and throw a raw Big.js division-by-zero, instead of failing closed with the
 * same `{allowed:false, code, reason}` shape as every other rejection path in
 * this module — the same "cannot evaluate, so deny" treatment
 * `checkFundingBlackout` (risk/economics.ts) gives non-finite input.
 */
export function sizePosition(input: SizingInput): SizingOutcome {
  const maxResidualDeltaFraction = input.maxResidualDeltaFraction ?? DEFAULT_MAX_RESIDUAL_DELTA;

  if (input.targetNotional.lte(0)) {
    return {
      allowed: false,
      code: "TARGET_NOTIONAL_NOT_POSITIVE",
      reason: `targetNotional ${input.targetNotional.toString()} must be positive — a non-positive value defeats the FM-12 residual-delta guard below instead of being rejected outright (RISK-REGISTER.md FM-12).`,
    };
  }
  if (input.markPrice.lte(0)) {
    return {
      allowed: false,
      code: "MARK_PRICE_NOT_POSITIVE",
      reason: `markPrice ${input.markPrice.toString()} must be positive — a non-positive value defeats the FM-12 residual-delta guard below instead of being rejected outright (RISK-REGISTER.md FM-12).`,
    };
  }
  if (input.perpQtyStep.lte(0)) {
    return {
      allowed: false,
      code: "PERP_QTY_STEP_NOT_POSITIVE",
      reason: `perpQtyStep ${input.perpQtyStep.toString()} must be positive — a non-positive value defeats the FM-12 residual-delta guard below instead of being rejected outright (RISK-REGISTER.md FM-12).`,
    };
  }

  const residualDeltaFraction = input.perpQtyStep
    .div(2)
    .times(input.markPrice)
    .div(input.targetNotional);

  if (residualDeltaFraction.gt(maxResidualDeltaFraction)) {
    return {
      allowed: false,
      code: "RESIDUAL_DELTA_EXCEEDED",
      reason: `Residual delta ${residualDeltaFraction.toString()} exceeds ${maxResidualDeltaFraction.toString()} for qtyStep ${input.perpQtyStep.toString()} at notional ${input.targetNotional.toString()} (RISK-REGISTER.md FM-12).`,
    };
  }

  const rawQty = input.targetNotional.div(input.markPrice);
  const stepCount = rawQty.div(input.perpQtyStep).round(0, 0); // 0 = ROUND_DOWN, never round up into a naked short
  const perpQty = stepCount.times(input.perpQtyStep);

  return { allowed: true, perpQty, spotQty: perpQty, residualDeltaFraction };
}
