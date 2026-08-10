import type Big from "big.js";
import { checkAccountMMRate, checkConcentration, checkLeverage, CONCENTRATION_MAX } from "./leverage.js";
import { checkSlippage, checkTurnover, estimateSlippage, MIN_PERP_TURNOVER_24H, MIN_SPOT_TURNOVER_24H } from "./liquidity.js";
import { checkEntryThreshold, checkFundingBlackout, checkNetFundingRate, isPremiumDriven, DEFAULT_FUNDING_REALIZATION_FACTOR } from "./economics.js";
import type { VetoResult } from "./types.js";
import { deny } from "./types.js";
import type { OrderbookLevel } from "../market-data/types.js";

/**
 * The narrow set of PARAMS-CONSERVATIVE.md limits an EMULATION may override to
 * measure what a different setting would have done. Production callers pass
 * nothing and get DEFAULT_RISK_THRESHOLDS, i.e. the real documented limits.
 *
 * Deliberately kept small. checkEntry's other checks (funding-rate economics,
 * slippage, effective leverage, account MMR) have no override: real market data
 * has shown symbols organically clearing those bars, so there is no measurement
 * question to answer by loosening them. Each field here earned its place by a
 * concrete "we cannot answer this without measuring it" question — do not add
 * more without the same justification. This is a measurement hatch, not a
 * general "loosen risk/" config surface, and nothing here changes what the live
 * bot enforces.
 */
export interface RiskThresholds {
  minPerpTurnover24h: Big;
  minSpotTurnover24h: Big;
  /**
   * PARAMS-CONSERVATIVE.md §11 / ТАБУ п.11's single-coin cap, on NOTIONAL (not
   * on committed capital — a delta-neutral position commits
   * `notional * (1 + 1/leverage)`, so a "how much of the deposit is working"
   * target converts to roughly HALF that in notional at leverage 1.0; see
   * strategy/capitalAllocation.ts). Overridable for the same reason the
   * turnover floors are: so an emulation can MEASURE what a looser cap does
   * before anyone argues for changing the production default.
   */
  maxConcentration: Big;
  /**
   * Haircut applied to a PREDICTED funding rate before it is credited as
   * expected income — see economics.ts's DEFAULT_FUNDING_REALIZATION_FACTOR
   * for the measurement behind the default. Overridable so a sweep can show
   * what the old implicit 1.0 was costing.
   */
  fundingRealizationFactor: Big;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  minPerpTurnover24h: MIN_PERP_TURNOVER_24H,
  minSpotTurnover24h: MIN_SPOT_TURNOVER_24H,
  maxConcentration: CONCENTRATION_MAX,
  fundingRealizationFactor: DEFAULT_FUNDING_REALIZATION_FACTOR,
};

/**
 * ARCHITECTURE.md §2: "strategy/ говорит 'хочу открыть позицию', risk/ имеет
 * право сказать 'нет'. Стратегия не может обойти риск-модуль." This is that
 * single point of entry — every field here is something a real entry decision
 * needs, and nothing here is optional: a caller missing a field cannot
 * construct this object at all (TypeScript enforces it), so a veto check
 * cannot be silently skipped by omission.
 *
 * Checks run in a fixed order and stop at the first denial (RR-28's veto is
 * absolute, not a score) — order is chosen so the cheapest, most-likely-to-fail
 * checks run first, though every check is O(1) or O(book depth) and none of
 * this is performance-sensitive at Phase 2's scale.
 */
export interface EntryCheckInput {
  projectedShortNotional: Big;
  projectedSpotLegNotional: Big;
  totalEquity: Big;
  projectedAccountMMRate: Big;

  perpTurnover24h: Big;
  spotTurnover24h: Big;
  perpBids: OrderbookLevel[]; // perp leg enters SHORT (PARAMS-CONSERVATIVE.md §6) — selling consumes the bid side, per risk/liquidity.ts's own doc ("asks to buy, bids to sell")
  spotAsks: OrderbookLevel[]; // spot leg enters LONG — buying consumes the ask side
  targetNotional: Big;

  premiumIndexR8h: Big;
  r8h: Big;
  expectedHoldIntervals: Big;
  totalRoundTripCost: Big;
  /** RR-25a: USDT borrow cost, normalized to r8h basis — see checkNetFundingRate. */
  borrowCost8h: Big;

  nowMs: number;
  nextFundingTimeMs: number;

  isInnovationOrAdventureZone: boolean;
}

/**
 * RR-28 (SRS.md): every check below is independently unit-tested in its own
 * module (risk/leverage.test.ts, risk/liquidity.test.ts, risk/economics.test.ts)
 * — this function's own tests (risk/index.test.ts) verify COMPOSITION: that a
 * denial from any single check propagates as the overall result, and that all
 * checks passing together is required for an overall allow. It deliberately
 * does not re-test each check's internal boundary math — that would duplicate
 * risk/leverage.test.ts etc. rather than testing anything new.
 */
export function checkEntry(input: EntryCheckInput, thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS): VetoResult {
  // PARAMS-CONSERVATIVE.md §4: zone exclusion is a flat veto, checked first —
  // cheapest possible check, and everything downstream is moot if it fails.
  if (input.isInnovationOrAdventureZone) {
    return deny(
      "ZONE_EXCLUDED",
      "Symbol is in Innovation or Adventure Zone — excluded entirely (PARAMS-CONSERVATIVE.md §4).",
    );
  }

  const turnoverResult = checkTurnover(
    input.perpTurnover24h,
    input.spotTurnover24h,
    thresholds.minPerpTurnover24h,
    thresholds.minSpotTurnover24h,
  );
  if (!turnoverResult.allowed) return turnoverResult;

  if (!isPremiumDriven(input.premiumIndexR8h)) {
    return deny(
      "FUNDING_RATE_NOT_PREMIUM_DRIVEN",
      "Normalized premium index does not exceed +0.05%/8h — rate may be pinned to the clamp floor/cap, not a real signal (RISK-REGISTER.md FM-01).",
    );
  }

  const entryThresholdResult = checkEntryThreshold(
    input.r8h,
    input.expectedHoldIntervals,
    input.totalRoundTripCost,
    thresholds.fundingRealizationFactor,
  );
  if (!entryThresholdResult.allowed) return entryThresholdResult;

  const netFundingResult = checkNetFundingRate(input.r8h, input.borrowCost8h);
  if (!netFundingResult.allowed) return netFundingResult;

  const blackoutResult = checkFundingBlackout(input.nowMs, input.nextFundingTimeMs);
  if (!blackoutResult.allowed) return blackoutResult;

  const perpSlippage = estimateSlippage(input.perpBids, input.targetNotional);
  const perpSlippageResult = checkSlippage(perpSlippage);
  if (!perpSlippageResult.allowed) return perpSlippageResult;

  const spotSlippage = estimateSlippage(input.spotAsks, input.targetNotional);
  const spotSlippageResult = checkSlippage(spotSlippage);
  if (!spotSlippageResult.allowed) return spotSlippageResult;

  const leverageResult = checkLeverage(input.projectedShortNotional, input.totalEquity);
  if (!leverageResult.allowed) return leverageResult;

  const concentrationResult = checkConcentration(
    input.projectedSpotLegNotional,
    input.totalEquity,
    thresholds.maxConcentration,
  );
  if (!concentrationResult.allowed) return concentrationResult;

  const mmrResult = checkAccountMMRate(input.projectedAccountMMRate);
  if (!mmrResult.allowed) return mmrResult;

  return { allowed: true };
}

export type { VetoResult } from "./types.js";
export { checkLeverage, checkAccountMMRate, checkConcentration, CONCENTRATION_MAX } from "./leverage.js";
export { checkTurnover, checkSlippage, estimateSlippage } from "./liquidity.js";
export type { SlippageEstimate } from "./liquidity.js";
export {
  isPremiumDriven,
  checkEntryThreshold,
  checkFundingBlackout,
  checkNetFundingRate,
  computeNetFundingRate,
  checkFeeRateSanity,
  DEFAULT_FUNDING_REALIZATION_FACTOR,
} from "./economics.js";
export { checkDrawdown, computeDrawdown } from "./drawdown.js";
