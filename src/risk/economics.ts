import Big from "big.js";
import { allow, deny } from "./types.js";
import type { VetoResult } from "./types.js";

const PREMIUM_DRIVEN_THRESHOLD_R8H = new Big("0.0005"); // +0.05%/8h, RISK-REGISTER.md FM-01
const ENTRY_FLOOR_R8H = new Big("0.0002"); // 0.020%/8h — never 0.010%, PARAMS-CONSERVATIVE.md §5
const ENTRY_GROSS_MULTIPLIER = new Big("2.0"); // K, RR-24/FM-01
const DEFAULT_BLACKOUT_SECONDS = 60; // RISK-REGISTER.md FM-40
// PARAMS-CONSERVATIVE.md §6: real VIP0 per-leg rates are ~0.055-0.10%
// (spot maker=taker 0.10%, perp taker ~0.055%, round-trip 0.31%/4 legs); even
// Innovation/Adventure Zone's worse 0.62% round-trip is ~0.155%/leg, and
// those zones are excluded from the universe entirely. 1% is chosen with
// generous headroom above every real rate this project has ever measured
// (≥6x the worst one seen), while still decisively catching a corrupted or
// misparsed fee-rate response — TEST-CASES.md #48's own illustrative "2%"
// fixture is exactly this class of value.
const MAX_SANE_FEE_RATE = new Big("0.01");

/**
 * RISK-REGISTER.md FM-01: Bybit clamps the funding rate to exactly its
 * interval floor/cap whenever the premium index is small — a rate sitting at
 * that clamp is a formula artifact, not a real signal, and a backtest entering
 * on clamped rates alone lost money (BTC -15.4%, SOL -45.7% of notional).
 * `premiumIndexR8h` must already be normalized to the 8h basis by the caller.
 */
export function isPremiumDriven(premiumIndexR8h: Big): boolean {
  return premiumIndexR8h.gt(PREMIUM_DRIVEN_THRESHOLD_R8H);
}

/**
 * RR-24/RR-25 (SRS.md), FM-01 (RISK-REGISTER.md): two independent gates, both
 * required. (1) `r8h` itself must never be allowed down to the clamp floor —
 * PARAMS-CONSERVATIVE.md §5 fixes this at 0.020%/8h regardless of what the
 * expected-gross arithmetic below would otherwise allow. (2) expected gross
 * income over the expected holding period must clear `K=2.0` times the full
 * round-trip cost (four legs of fees + basis + slippage — computed by the
 * caller as `totalRoundTripCost`, this function does not assemble that figure).
 */
export function checkEntryThreshold(
  r8h: Big,
  expectedHoldIntervals: Big,
  totalRoundTripCost: Big,
): VetoResult {
  if (r8h.lt(ENTRY_FLOOR_R8H)) {
    return deny(
      "FUNDING_RATE_BELOW_FLOOR",
      `r8h ${r8h.toString()} is below the ${ENTRY_FLOOR_R8H.toString()} entry floor (PARAMS-CONSERVATIVE.md §5).`,
    );
  }

  const expectedGross = r8h.times(expectedHoldIntervals);
  const requiredGross = totalRoundTripCost.times(ENTRY_GROSS_MULTIPLIER);
  if (expectedGross.lt(requiredGross)) {
    return deny(
      "EXPECTED_GROSS_TOO_LOW",
      `Expected gross ${expectedGross.toString()} is below ${ENTRY_GROSS_MULTIPLIER.toString()}x round-trip cost ${requiredGross.toString()} (RR-24, RISK-REGISTER.md FM-01).`,
    );
  }

  return allow();
}

/**
 * RISK-REGISTER.md FM-09: borrow cost, when the spot leg is ever financed on
 * margin, can exceed gross funding income on majors — this must be netted out
 * before any entry decision, not treated as a rounding error. Returns a signed
 * value; callers compare it against their own minimum net threshold.
 */
export function computeNetFundingRate(r8h: Big, borrowCost8h: Big): Big {
  return r8h.minus(borrowCost8h);
}

// FM-09/RSK-24 names this threshold ("жёсткое вето при r_net < minNetFundingRate")
// but does not pin a number. Reusing ENTRY_FLOOR_R8H rather than inventing a
// separate figure: that floor already represents "the minimum funding income
// worth the operational risk of holding a position at all" (PARAMS-CONSERVATIVE.md
// §5) — the same reasoning applies once Auto-Borrow cost (FM-27) is netted out,
// not some separately-justified weaker bar.
const MIN_NET_FUNDING_RATE_R8H = ENTRY_FLOOR_R8H;

/**
 * RR-25a (SRS.md): "Ожидаемый чистый доход r_net = r8h − borrowCost8h обязан
 * быть учтён в проверке окупаемости." FM-27: Auto-Borrow can activate on ANY
 * delta-neutral position the instant the short leg is underwater on price —
 * PARAMS-CONSERVATIVE.md §5 keeps this check in the code specifically as
 * insurance against that, even though it's expected to be a no-op under
 * "spot funded only with own money."
 */
export function checkNetFundingRate(r8h: Big, borrowCost8h: Big): VetoResult {
  const netRate = computeNetFundingRate(r8h, borrowCost8h);
  if (netRate.lt(MIN_NET_FUNDING_RATE_R8H)) {
    return deny(
      "NET_FUNDING_RATE_BELOW_FLOOR",
      `Net funding rate ${netRate.toString()} (r8h ${r8h.toString()} minus borrowCost8h ${borrowCost8h.toString()}) is below the ${MIN_NET_FUNDING_RATE_R8H.toString()} floor (RR-25a, RISK-REGISTER.md FM-09).`,
    );
  }
  return allow();
}

/**
 * RISK-REGISTER.md FM-40: "Opening or closing a position within 5 seconds
 * before and after the funding timestamp does not guarantee its
 * inclusion/exclusion" (Bybit's own documented behaviour) — a blackout window
 * well beyond that 5s guarantees the entry doesn't gamble on which side of a
 * settlement it lands.
 */
export function checkFundingBlackout(
  nowMs: number,
  nextFundingTimeMs: number,
  blackoutSeconds: number = DEFAULT_BLACKOUT_SECONDS,
): VetoResult {
  // nowMs/nextFundingTimeMs are plain `number`, not `Big` — this function is
  // the one place in risk/ that isn't automatically protected by Big's own
  // "throw on invalid input" behavior (`new Big(NaN)` throws; a NaN `number`
  // does not). Without this guard, a NaN input (e.g. a symbol whose
  // nextFundingTime failed to parse upstream) makes `distanceMs` NaN, and
  // EVERY comparison against NaN in JS is false — so the deny branch below
  // was silently skipped and the function fell through to allow() on
  // literally the one thing it exists to check. Fail closed, not open: a
  // veto function that can't determine distance-to-settlement must deny, the
  // same as if it were provably inside the blackout window.
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextFundingTimeMs)) {
    return deny(
      "FUNDING_SETTLEMENT_BLACKOUT",
      `Cannot determine distance to funding settlement — nowMs=${nowMs}, nextFundingTimeMs=${nextFundingTimeMs} (at least one is not finite). Failing closed per RISK-REGISTER.md FM-40.`,
    );
  }

  const blackoutMs = blackoutSeconds * 1000;
  const distanceMs = Math.abs(nextFundingTimeMs - nowMs);
  if (distanceMs <= blackoutMs) {
    return deny(
      "FUNDING_SETTLEMENT_BLACKOUT",
      `Within ${blackoutSeconds}s of a funding settlement (distance ${distanceMs}ms) — RISK-REGISTER.md FM-40.`,
    );
  }
  return allow();
}

/**
 * RR-26 (SRS.md): "Ставки комиссий читаются из /v5/account/fee-rate при
 * старте. Захардкоженные VIP 0 используются только как fallback." This is
 * the sanity half of that requirement — a fee rate the exchange actually
 * returns, but far outside anything real (a parsing bug upstream, a wrong
 * field read, a units mismatch like reading a percent as a fraction), must
 * refuse to start rather than silently feed a nonsense number into every
 * downstream cost calculation (checkEntryThreshold's round-trip cost,
 * computeRealizedPnl's fee component, ...). A STARTUP check, not a
 * per-candidate veto like the rest of this module — called once when
 * /v5/account/fee-rate is read, not per entry evaluation, so it is
 * deliberately not part of checkEntry's composition in risk/index.ts.
 */
export function checkFeeRateSanity(feeRate: Big): VetoResult {
  if (feeRate.gt(MAX_SANE_FEE_RATE)) {
    return deny(
      "FEE_RATE_IMPLAUSIBLE",
      `Fee rate ${feeRate.toString()} exceeds the ${MAX_SANE_FEE_RATE.toString()} sanity ceiling — refusing to start rather than trust a value this far outside every real rate this project has measured (RR-26, PARAMS-CONSERVATIVE.md §6).`,
    );
  }
  return allow();
}
