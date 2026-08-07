import Big from "big.js";
import { allow, deny } from "./types.js";
import type { VetoResult } from "./types.js";

const LEVERAGE_MAX = new Big("1.5");
const ACCOUNT_MMR_MAX = new Big("0.30");
const CONCENTRATION_MAX = new Big("0.25");

/**
 * RR-20 (SRS.md) / DECISIONS.md ADR-006 п.4: Bybit does not define "effective
 * leverage" itself, so the formula (short leg notional / total equity) is fixed
 * here rather than left to convention — ТАБУ п.11 would otherwise be unverifiable.
 * Target working value is 1.0x (a strategy/ concern); this enforces only the hard
 * ceiling of 1.5x from PARAMS-CONSERVATIVE.md §10.
 *
 * `totalEquity <= 0` cannot happen under correct business logic (the account is
 * dead, not merely risky, at zero-or-negative equity), so it is deliberately not
 * modeled as a veto outcome — the caller must guarantee positive equity.
 */
export function checkLeverage(shortNotional: Big, totalEquity: Big): VetoResult {
  if (totalEquity.lte(0)) {
    throw new RangeError(`totalEquity must be positive, got ${totalEquity.toString()}`);
  }

  // A real short leg notional cannot be negative — that implies an upstream
  // sign/subtraction bug, not a legitimate position. Left unguarded, the
  // one-sided `.gt(LEVERAGE_MAX)` check below never fires for a negative
  // ratio (it's always far under the ceiling), so this would silently sail
  // through allow() on exactly the input a veto exists to catch. Denied
  // (not thrown) for the same reason checkFundingBlackout's NaN guard denies
  // rather than throws: this is an implausible-but-reachable input from a
  // caller bug, not the "account is dead" state totalEquity<=0 represents.
  if (shortNotional.lt(0)) {
    return deny(
      "LEVERAGE_NOTIONAL_IMPLAUSIBLE",
      `shortNotional ${shortNotional.toString()} is negative — not a legitimate short leg notional, failing closed instead of passing the one-sided ${LEVERAGE_MAX.toString()}x ceiling check (RR-20).`,
    );
  }

  const effectiveLeverage = shortNotional.div(totalEquity);
  if (effectiveLeverage.gt(LEVERAGE_MAX)) {
    return deny(
      "LEVERAGE_EXCEEDED",
      `Effective leverage ${effectiveLeverage.toString()}x exceeds the ${LEVERAGE_MAX.toString()}x hard ceiling (PARAMS-CONSERVATIVE.md §10).`,
    );
  }
  return allow();
}

/**
 * RR-20a (SRS.md) / RISK-REGISTER.md FM-25: Bybit's Unified Trading Account
 * liquidates at the ACCOUNT level (`accountMMRate`), not per-position — one bad
 * pair can force-close otherwise-healthy delta-neutral positions alongside it.
 * RR-20's "short notional / equity" leverage check does not cover this failure
 * mode at all, hence this separate veto.
 *
 * Does NOT call the exchange and does NOT compute MMR itself: `projectedAccountMMRate`
 * must already be the result of a pre-trade simulation (e.g. Bybit's IMR/MMR
 * simulation endpoint) supplied by the caller — sourcing that projection is out of
 * scope here.
 *
 * Boundary is `>=`, not `>`: this guards against liquidation itself, not a budget, so the threshold value is denied rather than allowed.
 */
export function checkAccountMMRate(projectedAccountMMRate: Big): VetoResult {
  if (projectedAccountMMRate.gte(ACCOUNT_MMR_MAX)) {
    return deny(
      "ACCOUNT_MMR_EXCEEDED",
      `Projected account MMR ${projectedAccountMMRate.toString()} reaches the ${ACCOUNT_MMR_MAX.toString()} liquidation-risk ceiling (RISK-REGISTER.md FM-25).`,
    );
  }
  return allow();
}

/**
 * RR-21 (SRS.md) / PARAMS-CONSERVATIVE.md §11: no more than 25% of total equity
 * in a single coin, measured by the SPOT leg's notional — equal to the short leg's
 * notional in a delta-neutral pair, which is why the spot leg is the value taken
 * here rather than the short leg directly.
 *
 * Same `totalEquity <= 0` guard as checkLeverage above, and for the same reason:
 * that state cannot happen under correct business logic, so it throws a
 * documented RangeError instead of being modeled as a veto outcome. Without
 * this guard, checkConcentration is called directly by callers other than
 * checkEntry (see TEST-CASES.md #63 in test/risk/index.test.ts), so
 * checkEntry's fixed check order — where checkLeverage runs first and would
 * already have thrown — does not protect every caller.
 */
export function checkConcentration(spotLegNotional: Big, totalEquity: Big): VetoResult {
  if (totalEquity.lte(0)) {
    throw new RangeError(`totalEquity must be positive, got ${totalEquity.toString()}`);
  }

  // Same rationale as checkLeverage's shortNotional guard above: a real spot
  // leg notional cannot be negative, and the one-sided `.gt(CONCENTRATION_MAX)`
  // check below never fires for a negative ratio, so this fails closed instead
  // of silently allowing.
  if (spotLegNotional.lt(0)) {
    return deny(
      "CONCENTRATION_NOTIONAL_IMPLAUSIBLE",
      `spotLegNotional ${spotLegNotional.toString()} is negative — not a legitimate spot leg notional, failing closed instead of passing the one-sided ${CONCENTRATION_MAX.toString()} cap check (RR-21).`,
    );
  }

  const concentration = spotLegNotional.div(totalEquity);
  if (concentration.gt(CONCENTRATION_MAX)) {
    return deny(
      "CONCENTRATION_EXCEEDED",
      `Position concentration ${concentration.toString()} exceeds the ${CONCENTRATION_MAX.toString()} single-coin cap (PARAMS-CONSERVATIVE.md §11).`,
    );
  }
  return allow();
}
