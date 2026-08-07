import type Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { checkEntry } from "../../risk/index.js";
import { estimateSlippage } from "../../risk/liquidity.js";
import { computeTotalRoundTripCost } from "../../risk/totalRoundTripCost.js";
import { rankCandidates, computeCandidateYield } from "../../strategy/rankCandidates.js";
import { sizePosition } from "../../strategy/sizing.js";
import { normalizeFundingRateToR8h } from "../../market-data/normalizeFunding.js";
import { latestLongShortRatioAtOrBefore } from "../../market-data/collectLongShortRatio.js";
import { computeBorrowCost8h } from "../borrowCost.js";
import { computeMaintenanceMargin, lookupMarginTier } from "../liquidation.js";
import { latestPredictedFundingAtOrBefore, latestTickerAtOrBefore, orderbookSideAtOrBefore, latestOpenInterestAtOrBefore } from "./dbReaders.js";
import { DEFAULT_PERP_QTY_STEP, EXPECTED_PAYBACK_MINUTES } from "./types.js";
import type { ResolvedScenarioConfig, CandidateEvaluation } from "./types.js";

/**
 * scenarioRunner split (mechanical refactor): candidate ranking/selection —
 * evaluateCandidate (entry-side veto + scoring for one symbol at one tick)
 * and pickBestCandidate (RR-22's "at most one open position" entry point,
 * fans evaluateCandidate out across the whole symbol universe). See the
 * barrel's module doc comment (../../emulation/scenarioRunner.ts) for the
 * look-ahead discipline these both depend on.
 */

// ---------------------------------------------------------------------------
// Candidate evaluation (entry side)
// ---------------------------------------------------------------------------

async function evaluateCandidate(
  db: Kysely<Database>,
  resolved: ResolvedScenarioConfig,
  symbol: string,
  t: Date,
  availableEquity: Big,
  sizeFraction: Big,
): Promise<CandidateEvaluation | undefined> {
  const predicted = await latestPredictedFundingAtOrBefore(db, symbol, t);
  if (!predicted) return undefined;

  const perpTicker = await latestTickerAtOrBefore(db, symbol, "linear", t);
  const spotTicker = await latestTickerAtOrBefore(db, symbol, "spot", t);
  if (!perpTicker || perpTicker.markPrice === null || !spotTicker) return undefined;

  const perpMarkPrice = perpTicker.markPrice;
  const spotPrice = spotTicker.lastPrice;
  const r8h = normalizeFundingRateToR8h(predicted.rate, predicted.intervalMinutes);
  const currentBasis = perpMarkPrice.minus(spotPrice).div(spotPrice);

  const targetNotional = resolved.positionSizeUsd ?? availableEquity.times(sizeFraction);
  if (targetNotional.lte(0)) return undefined;

  const perpQtyStep = resolved.perpQtyStepBySymbol[symbol] ?? DEFAULT_PERP_QTY_STEP;
  const sized = sizePosition({ targetNotional, markPrice: perpMarkPrice, perpQtyStep });
  if (!sized.allowed) return undefined;
  if (sized.perpQty.lte(0)) return undefined;

  const perpBids = await orderbookSideAtOrBefore(db, symbol, "linear", "bid", t);
  const spotAsks = await orderbookSideAtOrBefore(db, symbol, "spot", "ask", t);

  const entryPerpSlip = estimateSlippage(perpBids, targetNotional);
  const entrySpotSlip = estimateSlippage(spotAsks, targetNotional);

  // Estimate: current (already-observable-at-T) basis magnitude, used both as
  // the pre-trade cost estimate here and as strategy/exitRules.ts's
  // basisDivergence measure later — PARAMS-CONSERVATIVE.md §7.3 reads as the
  // raw basis itself exceeding the threshold, not a change since entry.
  const expectedBasisDivergence = currentBasis.abs();

  const totalRoundTripCost = computeTotalRoundTripCost({
    entrySpotFeeRate: resolved.spotTakerFeeRate,
    entryPerpFeeRate: resolved.perpTakerFeeRate,
    exitSpotFeeRate: resolved.spotTakerFeeRate,
    exitPerpFeeRate: resolved.perpTakerFeeRate,
    expectedBasisDivergence,
    entrySpotSlippageBp: entrySpotSlip.slippageBp,
    entryPerpSlippageBp: entryPerpSlip.slippageBp,
    // Exit-side estimates reuse entry-side figures — RISK-REGISTER.md FM-03's
    // documented "lower bound assumption" convention (totalRoundTripCost.ts's
    // own doc comment); the exit-time book doesn't exist yet at decision time.
    exitSpotSlippageBp: entrySpotSlip.slippageBp,
    exitPerpSlippageBp: entryPerpSlip.slippageBp,
  });

  const borrowCost8h = computeBorrowCost8h(
    resolved.leverage,
    sized.perpQty.times(perpMarkPrice),
    resolved.hourlyBorrowRate,
  );

  const expectedHoldIntervals = EXPECTED_PAYBACK_MINUTES.div(predicted.intervalMinutes);

  const projectedShortNotional = sized.perpQty.times(perpMarkPrice);
  const projectedSpotLegNotional = sized.spotQty.times(spotPrice);

  const tier = lookupMarginTier(symbol, projectedShortNotional);
  const projectedAccountMMRate = computeMaintenanceMargin(projectedShortNotional, tier).div(availableEquity);

  const veto = checkEntry({
    projectedShortNotional,
    projectedSpotLegNotional,
    totalEquity: availableEquity,
    projectedAccountMMRate,
    perpTurnover24h: perpTicker.turnover24h,
    spotTurnover24h: spotTicker.turnover24h,
    perpBids,
    spotAsks,
    targetNotional,
    // See module doc comment: no stored premium-index field, r8h itself is the proxy.
    premiumIndexR8h: r8h,
    r8h,
    expectedHoldIntervals,
    totalRoundTripCost,
    borrowCost8h,
    nowMs: t.getTime(),
    nextFundingTimeMs: predicted.nextFundingTimeMs,
    isInnovationOrAdventureZone: false,
  });

  if (!veto.allowed) {
    console.debug(
      `[scenarioRunner] entry vetoed symbol=${symbol} at=${t.toISOString()} code=${veto.code} reason=${veto.reason}`,
    );
    return undefined;
  }

  // Context-only market data for entry_reasoning — fetched only once the
  // candidate has actually cleared the veto, so a symbol that gets rejected
  // (the common case, most ticks) doesn't pay for two more queries it will
  // never use. See latestOpenInterestAtOrBefore/latestLongShortRatioAtOrBefore
  // doc comments: neither can veto a candidate, only describe it.
  const openInterest = await latestOpenInterestAtOrBefore(db, symbol, t);
  const longShortRatio = await latestLongShortRatioAtOrBefore(db, symbol, t);

  return {
    symbol,
    r8h,
    perpMarkPrice,
    spotPrice,
    currentBasis,
    perpQty: sized.perpQty,
    spotQty: sized.spotQty,
    entrySpotSlippageBp: entrySpotSlip.slippageBp,
    entryPerpSlippageBp: entryPerpSlip.slippageBp,
    tier,
    legNotional: projectedShortNotional,
    openInterest,
    longShortRatio,
  };
}

/**
 * RR-22: evaluates every symbol in the universe, ranks every one that clears
 * risk/index.ts's checkEntry via strategy/rankCandidates.ts, and returns ONLY the
 * top-ranked candidate — the caller opens at most this one. This function itself
 * never opens more than it returns; RR-22's "at most one open position at a time"
 * invariant is enforced by the caller only ever invoking this when flat.
 */
export async function pickBestCandidate(
  db: Kysely<Database>,
  resolved: ResolvedScenarioConfig,
  t: Date,
  availableEquity: Big,
  sizeFraction: Big,
): Promise<CandidateEvaluation | undefined> {
  // Evaluated concurrently, not one-symbol-at-a-time: evaluateCandidate is a
  // pure read (no shared mutable state, no cross-symbol ordering dependency —
  // pickBestCandidate ranks the full `passing` set afterward regardless of
  // arrival order), so a sequential for-await loop here was paying one full
  // network round-trip's latency per symbol per query for no correctness
  // benefit. At real-universe scale (~300 symbols x up to 5 queries each
  // before a veto decision) that made a full scenario run over even one day
  // of data impractically slow (confirmed live: minutes per tick, sequential,
  // vs. sub-second once parallelized) — found running the first real-data
  // preliminary emulation (2026-08-06), not caught by any test fixture, which
  // only ever use a handful of symbols. Bounded implicitly by the `db` pool's
  // own connection limit (pg.Pool default max=10, storage/db.ts) — excess
  // queries queue on the pool rather than opening unbounded connections.
  const evaluations = await Promise.all(
    resolved.symbols.map((symbol) => evaluateCandidate(db, resolved, symbol, t, availableEquity, sizeFraction)),
  );
  const passing: CandidateEvaluation[] = evaluations.filter((e): e is CandidateEvaluation => e !== undefined);
  if (passing.length === 0) return undefined;

  const ranked = rankCandidates(
    passing.map((c) => ({ symbol: c.symbol, yield: computeCandidateYield(c.r8h, c.legNotional, availableEquity) })),
  );
  const top = ranked[0];
  if (!top) return undefined;
  return passing.find((c) => c.symbol === top.symbol);
}
