import Big from "big.js";

/**
 * 0.5%, PARAMS-CONSERVATIVE.md §7.3. Exported because risk/basisStability.ts's
 * entry-side check measures how much room a candidate has before THIS stop —
 * the two numbers must be the same number, not two copies that can drift.
 */
export const BASIS_DIVERGENCE_THRESHOLD = new Big("0.005");
const APR_HYSTERESIS_FACTOR = "0.5"; // 50% of entry APR, PARAMS-CONSERVATIVE.md §7.2
const MIN_FUNDING_PAYMENTS_FOR_PLANNED_EXIT = 1; // FR-303 (SRS.md)

export interface ExitCheckInput {
  /** Signed, r8h-normalized rate predicted for the next funding interval. */
  predictedNextFundingRate: Big;
  currentApr: Big;
  /** APR at position entry — the hysteresis baseline reason 2 compares against. */
  entryApr: Big;
  /** Absolute divergence between the two legs' basis, e.g. `Big("0.006")` = 0.6%. */
  basisDivergence: Big;
  isDelistedOrContractChanged: boolean;
  /** Funding payments collected so far on this position; integer, >= 0. */
  fundingPaymentsCollected: number;
}

export type ExitDecision =
  | { shouldExit: true; code: string; reason: string; urgent: boolean }
  | { shouldExit: false };

/**
 * PARAMS-CONSERVATIVE.md §7 / FR-302 (SRS.md): exit on any of four conditions.
 * Reasons 3 (BASIS_DIVERGED) and 4 (DELISTED_OR_CONTRACT_CHANGED) are emergency
 * exits and fire unconditionally; reasons 1 (FUNDING_TURNED_NEGATIVE) and 2
 * (APR_HYSTERESIS_TRIGGERED) are planned exits, gated by FR-303's minimum hold
 * of one collected funding payment — otherwise a position could enter and exit
 * paying the round-trip cost without ever collecting funding.
 *
 * Checked in order 3 -> 4 -> 1 -> 2; when several conditions hold at once, the
 * first one in that order is returned.
 */
export function checkExit(input: ExitCheckInput): ExitDecision {
  if (input.basisDivergence.gt(BASIS_DIVERGENCE_THRESHOLD)) {
    return {
      shouldExit: true,
      code: "BASIS_DIVERGED",
      reason: `Basis divergence ${input.basisDivergence.toString()} exceeds the ${BASIS_DIVERGENCE_THRESHOLD.toString()} emergency threshold (PARAMS-CONSERVATIVE.md §7.3).`,
      urgent: true,
    };
  }

  if (input.isDelistedOrContractChanged) {
    return {
      shouldExit: true,
      code: "DELISTED_OR_CONTRACT_CHANGED",
      reason: "Symbol is delisted or its contract parameters changed (PARAMS-CONSERVATIVE.md §7.4).",
      urgent: true,
    };
  }

  const heldMinimum = input.fundingPaymentsCollected >= MIN_FUNDING_PAYMENTS_FOR_PLANNED_EXIT;

  if (heldMinimum && input.predictedNextFundingRate.lt(0)) {
    return {
      shouldExit: true,
      code: "FUNDING_TURNED_NEGATIVE",
      reason: `Predicted next funding rate ${input.predictedNextFundingRate.toString()} is negative (PARAMS-CONSERVATIVE.md §7.1).`,
      urgent: false,
    };
  }

  const hysteresisFloor = input.entryApr.times(APR_HYSTERESIS_FACTOR);
  if (heldMinimum && input.currentApr.lt(hysteresisFloor)) {
    return {
      shouldExit: true,
      code: "APR_HYSTERESIS_TRIGGERED",
      reason: `Current APR ${input.currentApr.toString()} fell below ${hysteresisFloor.toString()} — ${APR_HYSTERESIS_FACTOR}x entry APR ${input.entryApr.toString()} (PARAMS-CONSERVATIVE.md §7.2).`,
      urgent: false,
    };
  }

  return { shouldExit: false };
}
