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
 */
export function sizePosition(input: SizingInput): SizingOutcome {
  const maxResidualDeltaFraction = input.maxResidualDeltaFraction ?? DEFAULT_MAX_RESIDUAL_DELTA;

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
