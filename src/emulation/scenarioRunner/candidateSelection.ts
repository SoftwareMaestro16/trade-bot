import type Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { checkEntry } from "../../risk/index.js";
import { estimateSlippage, checkTurnover } from "../../risk/liquidity.js";
import { computeTotalRoundTripCost } from "../../risk/totalRoundTripCost.js";
import { rankCandidates, computeCandidateYield } from "../../strategy/rankCandidates.js";
import { BASIS_DIVERGENCE_THRESHOLD } from "../../strategy/exitRules.js";
import { sizePosition } from "../../strategy/sizing.js";
import { normalizeFundingRateToR8h, REFERENCE_INTERVAL_MINUTES } from "../../market-data/normalizeFunding.js";
import { latestLongShortRatioAtOrBefore } from "../../market-data/collectLongShortRatio.js";
import { computeBorrowCost8h } from "../borrowCost.js";
import { computeMaintenanceMargin, lookupMarginTier } from "../liquidation.js";
import { latestPredictedFundingAtOrBefore, latestTickerAtOrBefore, orderbookSideAtOrBefore, latestOpenInterestAtOrBefore, trailingBasisStdDev } from "./dbReaders.js";
import { DEFAULT_PERP_QTY_STEP } from "./types.js";
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

  // Hoisted copy of the FIRST veto checkEntry would apply below (its zone check
  // is a compile-time `false` here, so turnover is effectively first). Purely a
  // cost optimization, semantically a no-op: identical inputs, identical veto,
  // and because nothing between here and checkEntry can produce a DIFFERENT
  // veto that should have won, hoisting cannot reorder which reason is
  // reported. Worth it because the two orderbookSideAtOrBefore calls below are
  // the most expensive queries in this function and the overwhelming majority
  // of (symbol, tick) pairs die right here — measured 2026-08-10: ~79k turnover
  // vetoes in the first 50 minutes of a sweep, each of which had already paid
  // for both orderbook reads it never used.
  const earlyTurnover = checkTurnover(
    perpTicker.turnover24h,
    spotTicker.turnover24h,
    resolved.riskThresholds.minPerpTurnover24h,
    resolved.riskThresholds.minSpotTurnover24h,
  );
  if (!earlyTurnover.allowed) {
    console.debug(
      `[scenarioRunner] entry vetoed symbol=${symbol} at=${t.toISOString()} code=${earlyTurnover.code} reason=${earlyTurnover.reason}`,
    );
    return undefined;
  }

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

  // Fetched concurrently with the books: all three are independent reads, and
  // the basis deviation is needed by checkEntry regardless of how the depth
  // analysis turns out.
  const [perpBids, spotAsks, basisStdDev] = await Promise.all([
    orderbookSideAtOrBefore(db, symbol, "linear", "bid", t),
    orderbookSideAtOrBefore(db, symbol, "spot", "ask", t),
    trailingBasisStdDev(db, symbol, t),
  ]);

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

  // BUG FOUND 2026-08-07 (workflow audit): this used to divide by
  // predicted.intervalMinutes (the symbol's own RAW settlement cadence)
  // instead of REFERENCE_INTERVAL_MINUTES (480, the basis r8h is already
  // normalized to). r8h is a per-8h rate regardless of the symbol's own
  // interval — mixing it with a raw-interval-based period count silently
  // inflated expectedGross below (r8h.times(expectedHoldIntervals) in
  // risk/economics.ts's checkEntryThreshold) by exactly
  // 480/intervalMinutes: 2x for the 240min symbols that are the bulk of the
  // universe, 8x for 60min symbols — collapsing the intended K=2.0 gross
  // margin down to an effective 1.0x (zero margin) or 0.25x (admits entries
  // whose true expected income doesn't even cover round-trip fees) for
  // exactly those symbols. Correct: T minutes / 480 minutes-per-r8h-period is
  // a CONSTANT (9 for the 3-day EXPECTED_PAYBACK_MINUTES window) independent
  // of intervalMinutes — verified against PARAMS-CONSERVATIVE.md §5's own
  // worked example (the 4h-symbol raw threshold is exactly half the 8h-symbol
  // raw threshold, i.e. identical once normalized to r8h).
  // Sourced from the resolved config (defaulting to EXPECTED_PAYBACK_MINUTES)
  // rather than the module constant directly — see ScenarioConfig's
  // expectedPaybackMinutes doc comment for why this became a sweepable input.
  const expectedHoldIntervals = resolved.expectedPaybackMinutes.div(REFERENCE_INTERVAL_MINUTES);

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
    currentBasis,
    basisStdDev,
    exitBasisThreshold: BASIS_DIVERGENCE_THRESHOLD,
    // Исторических deliveryTime в этой схеме нет — вето делистинга инертно в
    // бэктесте (0 = нет делистинга), но контракт готов для live (risk/delisting.ts).
    deliveryTimeMs: 0,
  }, resolved.riskThresholds);

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
  excludeSymbols: ReadonlySet<string> = new Set(),
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
  // Filtered BEFORE evaluation, not after: an excluded symbol is one already
  // held, and evaluating it would spend ~5 DB queries only to discard the
  // result — at ~300 symbols per tick that is the dominant cost in this loop.
  // Excluding held symbols also keeps two slots from landing in the same coin,
  // which is not diversification but one double-sized position in disguise,
  // and would slip past checkConcentration (it sees each leg separately).
  const candidateSymbols = resolved.symbols.filter((sym) => !excludeSymbols.has(sym));
  const evaluations = await Promise.all(
    candidateSymbols.map((symbol) => evaluateCandidate(db, resolved, symbol, t, availableEquity, sizeFraction)),
  );
  const passing: CandidateEvaluation[] = evaluations.filter((e): e is CandidateEvaluation => e !== undefined);
  if (passing.length === 0) return undefined;

  // RR-22 caps live trading at ONE open position until Phase 4 closes, so only
  // `ranked[0]` is ever acted on below and the rest of `passing` is discarded
  // silently. That discard hides the one number needed to judge whether lifting
  // the cap would earn anything: how many symbols clear the FULL veto chain at
  // the same instant. Four parallel slots multiply nothing if this is almost
  // always 1. Logged rather than returned because raising the cap is a separate
  // decision from measuring its ceiling — this line changes no behaviour.
  if (passing.length > 1) {
    console.debug(
      `[scenarioRunner] parallel-capacity at=${t.toISOString()} passing=${String(passing.length)} symbols=${passing.map((c) => c.symbol).join(",")}`,
    );
  }

  const ranked = rankCandidates(
    passing.map((c) => ({ symbol: c.symbol, yield: computeCandidateYield(c.r8h, c.legNotional, availableEquity) })),
  );
  const top = ranked[0];
  if (!top) return undefined;
  return passing.find((c) => c.symbol === top.symbol);
}
