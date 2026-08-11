import Big from "big.js";
import { allow, deny } from "./types.js";
import type { VetoResult } from "./types.js";

/**
 * Found 2026-08-11, from the parameter sweep's own trade log: 4 of 8 trades
 * exited via strategy/exitRules.ts's BASIS_DIVERGED emergency stop before
 * collecting a single funding payment, and those 4 produced 92% of the run's
 * total loss (-$4.05 of -$4.41), each shedding ~1% of notional.
 *
 * Nothing in checkEntry was asking the question those losses answer. The entry
 * chain checks whether income exists (funding), whether the position can be
 * entered and exited (turnover, slippage, depth), and whether it fits the
 * account (leverage, concentration, MMR) — but never whether the position can
 * SURVIVE long enough to collect the income it was entered for. A pair can
 * clear every existing veto and still be a guaranteed loss if its basis
 * routinely travels further than the stop within one settlement interval.
 *
 * Measured basis standard deviation over the 5-day window, against the 0.5%
 * emergency threshold (PARAMS-CONSERVATIVE.md §7.3):
 *
 *   ZBTUSDT   0.2635%  ->  1.9 sigma to the stop   (traded: 2 losses)
 *   GRVTUSDT  0.2172%  ->  2.3 sigma               (traded: 5, 4 losses)
 *   CAPUSDT   0.2033%  ->  2.5 sigma               (traded: 1 loss)
 *   HYPEUSDT  0.0190%  -> 26   sigma
 *   BTCUSDT   0.0067%  -> 75   sigma
 *   ETHUSDT   0.0066%  -> 76   sigma
 *
 * The pairs that lost money are 30-40x more basis-volatile than the majors.
 * For them a 0.5% excursion is an ordinary afternoon (observed ranges were
 * 2.8-3.7%); for BTC it is 75 standard deviations, i.e. it never happens. The
 * stop was not mis-set — it was being applied to instruments it can never
 * accommodate.
 */

/**
 * How much room the stop must leave, in standard deviations of the basis.
 *
 * 3 is a judgment call, not a fitted value, and is deliberately stated as such:
 * with only 8 trades there is nothing to fit, so this is chosen as the
 * conventional "clearly outside normal fluctuation" bar. What the data DOES
 * support is that the correct threshold lies somewhere in the wide gap between
 * the losers (1.9-2.5 sigma) and the majors (26-76 sigma) — anywhere in that
 * range separates them identically, so the exact number matters far less than
 * having the check at all. Revisit once there are enough BASIS_DIVERGED exits
 * to build a real distribution of "sigma at entry" vs outcome.
 */
export const MIN_SIGMAS_TO_STOP = new Big("3");

/**
 * `basisStdDev` is the standard deviation of `(perpMark - spotLast) / spotLast`
 * over a trailing window, and `null` when the caller could not compute one
 * (too little history for a freshly-listed symbol, say).
 *
 * A null deviation DENIES rather than passing through. That follows the same
 * fail-closed convention as checkFundingBlackout's non-finite guard: a veto
 * that cannot evaluate its own condition must refuse, because "we don't know
 * how volatile this basis is" is exactly the state this check exists to catch —
 * and a brand-new listing with no history is a textbook instance of it.
 *
 * The margin is measured from the CURRENT basis, not from zero. Two positions
 * on equally volatile instruments are not equally safe if one starts with the
 * basis already halfway to the stop: what matters is the distance still
 * available, `threshold - |currentBasis|`, expressed in standard deviations.
 */
export function checkBasisStability(
  currentBasis: Big,
  basisStdDev: Big | null,
  exitThreshold: Big,
  minSigmas: Big = MIN_SIGMAS_TO_STOP,
): VetoResult {
  if (basisStdDev === null) {
    return deny(
      "BASIS_VOLATILITY_UNKNOWN",
      "No basis-volatility history for this symbol — cannot establish that the position could survive to its " +
        "first funding settlement, so refusing rather than assuming stability (see module doc comment).",
    );
  }

  if (basisStdDev.lt(0)) {
    return deny(
      "BASIS_VOLATILITY_IMPLAUSIBLE",
      `basisStdDev ${basisStdDev.toString()} is negative — a standard deviation cannot be, so this is an upstream ` +
        "bug rather than a tradeable state; failing closed instead of dividing by it.",
    );
  }

  const remainingRoom = exitThreshold.minus(currentBasis.abs());
  if (remainingRoom.lte(0)) {
    return deny(
      "BASIS_ALREADY_AT_STOP",
      `Current basis ${currentBasis.toString()} already meets or exceeds the ${exitThreshold.toString()} emergency ` +
        "exit threshold — entering would open a position the exit rule closes on its next evaluation.",
    );
  }

  // Zero deviation means the basis has not moved at all across the window, so
  // the stop is infinitely far away in sigma terms. Handled before the divide
  // rather than after, since Big throws on division by zero.
  if (basisStdDev.eq(0)) {
    return allow();
  }

  const sigmas = remainingRoom.div(basisStdDev);
  if (sigmas.lt(minSigmas)) {
    return deny(
      "BASIS_TOO_VOLATILE",
      `Only ${sigmas.toFixed(2)} standard deviations of room between the current basis ${currentBasis.toString()} ` +
        `and the ${exitThreshold.toString()} emergency exit (basis sd ${basisStdDev.toString()}); ` +
        `${minSigmas.toString()} required. A normal fluctuation would stop this position out before its first ` +
        "funding settlement — see module doc comment for the trades that motivated this.",
    );
  }

  return allow();
}
