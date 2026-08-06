import Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import { checkEntry } from "../risk/index.js";
import { estimateSlippage } from "../risk/liquidity.js";
import { computeTotalRoundTripCost } from "../risk/totalRoundTripCost.js";
import { rankCandidates, computeCandidateYield } from "../strategy/rankCandidates.js";
import { checkExit } from "../strategy/exitRules.js";
import { sizePosition } from "../strategy/sizing.js";
import { normalizeFundingRateToR8h, r8hToApr } from "../market-data/normalizeFunding.js";
import type { OrderbookLevel } from "../market-data/types.js";
import { computeEquitySnapshot } from "./equityEngine.js";
import { computeBorrowCost8h } from "./borrowCost.js";
import { computeNextPositionSizeFraction } from "./adaptivePositionSizing.js";
import type { TradeOutcome } from "./adaptivePositionSizing.js";
import {
  computeDeltaNeutralPerpLegLiquidation,
  computeMaintenanceMargin,
  lookupMarginTier,
  simulateDeltaNeutralForcedLiquidation,
} from "./liquidation.js";
import type { DeltaNeutralLiquidationInput, MarginTier } from "./liquidation.js";
import { transition } from "./paperPositionState.js";
import type { PaperPositionState } from "./paperPositionState.js";
import { computeRealizedPnl } from "../execution/realizedPnl.js";

/**
 * Backlog #37/#38 (Фаза 2): the orchestrator that actually RUNS one paper-trading
 * scenario — the piece every other emulation/ module (equityEngine.ts, borrowCost.ts,
 * liquidation.ts, paperPositionState.ts) exists to be plugged into. Reads real
 * historical rows out of tickers/funding_rates/orderbook_levels, decides what a live
 * bot would have decided at each historical instant, and journals the result into
 * paper_positions/paper_fills/paper_funding_payments/paper_equity_snapshots.
 *
 * ============================================================================
 * LOOK-AHEAD DISCIPLINE — the single most important property of this file
 * ============================================================================
 * The replay walks discrete instants T taken from the real `tickers.fetched_at`
 * grid (never an invented clock — see `getTickTimestamps`). EVERY query this file
 * issues is bounded `fetched_at <= T` (or, for orderbook_levels, keyed off the
 * latest `fetched_at <= T` snapshot) — a query without that bound would let the
 * replay "see" a row that, at historical instant T, a live bot's collector had not
 * fetched yet.
 *
 * `funding_rates.kind` is the one place this rule gets a documented, deliberate
 * carve-out, because the table encodes two structurally different kinds of fact:
 *   - `kind='predicted'`: what Bybit's ticker endpoint forecasts for the NEXT
 *     settlement, current as of `fetched_at`. This is the ONLY funding data an
 *     entry decision may read — gated the ordinary way, `fetched_at <= T`
 *     (`latestPredictedFundingAtOrBefore`).
 *   - `kind='settled'`: what ACTUALLY happened, recorded via a periodic sweep of
 *     `/v5/market/funding/history` that can run hours or days after the real
 *     settlement instant (`funding_timestamp_ms`) it describes. Gating this table
 *     by `fetched_at <= T` would be WRONG in the opposite direction from the usual
 *     failure — a live bot does not need to wait for that historical-sweep
 *     collector to run before it knows it was paid: Bybit credits/debits funding
 *     directly into account balance the instant a settlement clears, at
 *     `funding_timestamp_ms`, regardless of when (or whether) any history sweep
 *     later records it. So the correct gate for "was this funding payment already
 *     real by time T" is `funding_timestamp_ms <= T` (`settledFundingSince`) — and
 *     `kind='settled'` rows are NEVER consulted for an entry/exit DECISION, only
 *     for crediting funding already economically realized on a position already
 *     open. See `test/emulation/scenarioRunner.test.ts`'s look-ahead fixture: a
 *     settled row can sit in the table from the very start of a scenario, with an
 *     early `funding_timestamp_ms` but a rate that would have justified an entry —
 *     and the entry must still wait for the PREDICTED rate to say so at its own,
 *     later `fetched_at`.
 *
 * ============================================================================
 * MAX ONE POSITION (RR-22)
 * ============================================================================
 * Enforced structurally, not by a counter: the main loop only ever calls
 * `pickBestCandidate` when `openPosition` is `null`. Multiple symbols qualifying
 * at the same tick are ranked by `strategy/rankCandidates.ts` and exactly the
 * top-ranked one is opened — see `test/emulation/scenarioRunner.test.ts`.
 *
 * ============================================================================
 * DOCUMENTED SIMPLIFICATIONS (things the DB schema / docs don't pin down)
 * ============================================================================
 * - `expectedHoldIntervals` (risk/economics.ts's checkEntryThreshold): derived
 *   from PARAMS-CONSERVATIVE.md §5's "круг комиссий должен окупаться за ≤ 3
 *   суток" — 3 days converted into the SYMBOL's own interval count. This matches
 *   test/risk/totalRoundTripCost.test.ts's own RR-24 worked example (9 intervals
 *   for a 480-minute/8h symbol == 3 days / 8h).
 * - `premiumIndexR8h` (risk/index.ts's isPremiumDriven gate): market-data/types.ts's
 *   own SymbolSnapshot.premiumIndexR8h doc comment states Bybit exposes no single
 *   documented "premium index" field, and this schema stores none separately —
 *   the normalized PREDICTED r8h rate itself is used as the proxy.
 * - `isInnovationOrAdventureZone`: not persisted anywhere in this schema (Фаза 1
 *   never collected it). Hardcoded `false` — the caller's `symbols` universe is
 *   assumed pre-curated to exclude those zones, the same assumption
 *   PARAMS-CONSERVATIVE.md §4 makes about the live universe.
 * - `perpQtyStep`: no instruments-info table exists in this schema (Фаза 1 never
 *   persisted it). Falls back to `DEFAULT_PERP_QTY_STEP`, overridable per-symbol
 *   via `ScenarioConfig.perpQtyStepBySymbol`.
 * - Position sizing (`positionSizeUsd`): PARAMS-CONSERVATIVE.md §1-3 says Phase
 *   2-3's position size should equal the eventual real-money size, not scale with
 *   the test deposit — but that real size is still an OPEN parameter (a $200
 *   placeholder), and even $200 against a $500 virtual deposit would exceed §11's
 *   25% concentration cap (200/500 = 40%). Owner's own resolution (2026-08-07):
 *   let the bot decide, adaptively — small with no track record or after a
 *   significant loss, larger after a run of wins. Implemented as
 *   `emulation/adaptivePositionSizing.ts`'s `computeNextPositionSizeFraction`,
 *   folded over this scenario's own closed-trade history so far and applied as
 *   a fraction of CURRENT equity; `positionSizeUsd` still overrides it entirely
 *   with a fixed dollar amount once Phase 4's real size is actually decided.
 * - Entry/exit FILL PRICES are the ticker mark/last price at that tick, not a
 *   book-walked average — the orderbook is still used for the actual RISK checks
 *   (checkEntry's slippage veto, this file's cost estimate) and its resulting
 *   `slippageBp` is charged as an explicit dollar cost via
 *   `realizedPnl.ts`'s `realizedSlippage` input, not folded into the price.
 * - `margin_balance` on paper_equity_snapshots: this schema/docs don't define the
 *   term precisely for a paper account. Approximated as total equity MINUS the
 *   open position's current spot-leg notional — mirroring PARAMS-CONSERVATIVE.md
 *   §1's own observed real account ("BTC и ETH не помечены как залог" — spot
 *   holdings are equity but not usable margin).
 */

// ---------------------------------------------------------------------------
// Fallback constants — every one is a documented, overridable default, never a
// silently-assumed truth. See ScenarioConfig fields for how to override.
// ---------------------------------------------------------------------------

/** No instruments-info table in this schema — see module doc comment. */
export const DEFAULT_PERP_QTY_STEP = new Big("0.001");

/** RR-26 fallback convention (VIP0). PARAMS-CONSERVATIVE.md §6: spot maker=taker on VIP0, 0.10%. */
export const SPOT_TAKER_FEE_RATE_FALLBACK = new Big("0.001");

/** RR-26 fallback convention (VIP0). risk/economics.ts's own comment: perp taker ~0.055%. */
export const PERP_TAKER_FEE_RATE_FALLBACK = new Big("0.00055");

/** emulation/borrowCost.ts's own cited live VIP0 snapshot (RISK-REGISTER.md FM-09), not a pinned production value. */
export const HOURLY_BORROW_RATE_FALLBACK = new Big("0.0000044069");

/** PARAMS-CONSERVATIVE.md §5: "круг комиссий должен окупаться за ≤ 3 суток". */
const EXPECTED_PAYBACK_MINUTES = new Big(3 * 24 * 60);

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScenarioConfig {
  name: string;
  /** Perp leg's OWN margin leverage (1.0 = fully self-funded, no borrowing) — NOT the same quantity as risk/leverage.ts's "effective leverage" (shortNotional/totalEquity), see module doc comment. */
  leverage: Big;
  startingDeposit: Big;
  /** Tradeable universe for this scenario — assumed pre-curated (no Innovation/Adventure Zone symbols), see module doc comment. */
  symbols: string[];
  startAt: Date;
  endAt: Date;
  perpQtyStepBySymbol?: Record<string, Big>;
  hourlyBorrowRate?: Big;
  spotTakerFeeRate?: Big;
  perpTakerFeeRate?: Big;
  /** Fixed target notional per leg, overriding the equity-fraction default — see module doc comment's "Position sizing". */
  positionSizeUsd?: Big;
}

export interface ScenarioRunResult {
  scenarioId: bigint;
  ticksProcessed: number;
  positionsOpened: number;
  positionsClosed: number;
  /** Total account equity at the end of the range — always fully flat (any still-open position is force-closed at range end). */
  finalEquity: Big;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ResolvedScenarioConfig {
  leverage: Big;
  symbols: string[];
  perpQtyStepBySymbol: Record<string, Big>;
  hourlyBorrowRate: Big;
  spotTakerFeeRate: Big;
  perpTakerFeeRate: Big;
  positionSizeUsd: Big | undefined;
}

interface TickerSnapshot {
  lastPrice: Big;
  markPrice: Big | null;
  turnover24h: Big;
}

interface PredictedFunding {
  rate: Big;
  intervalMinutes: number;
  nextFundingTimeMs: number;
}

interface SettledFunding {
  rate: Big;
  intervalMinutes: number;
  fundingTimestampMs: number;
}

interface LongShortRatioSnapshot {
  buyRatio: Big;
  sellRatio: Big;
}

interface CandidateEvaluation {
  symbol: string;
  r8h: Big;
  perpMarkPrice: Big;
  spotPrice: Big;
  currentBasis: Big;
  perpQty: Big;
  spotQty: Big;
  entrySpotSlippageBp: Big;
  entryPerpSlippageBp: Big;
  tier: MarginTier;
  legNotional: Big;
  /** Context-only, for entry_reasoning — never gates the veto (see evaluateCandidate). Undefined if no OI collected yet at/before t. */
  openInterest: Big | undefined;
  /** Context-only, for entry_reasoning — never gates the veto. Undefined if no long/short-ratio row collected yet at/before t. */
  longShortRatio: LongShortRatioSnapshot | undefined;
}

interface OpenPositionState {
  id: bigint;
  symbol: string;
  spotQty: Big;
  perpQty: Big;
  leverage: Big;
  spotEntryPrice: Big;
  perpEntryPrice: Big;
  entryBasis: Big;
  entryApr: Big;
  entryFees: Big;
  entrySpotSlippageBp: Big;
  entryPerpSlippageBp: Big;
  /** t.getTime() at open — fixed for the position's lifetime, unlike fundingAppliedThroughMs/lastBorrowAccrualMs below (both mutate as ticks pass). Used to compute hold duration for exit_reasoning. */
  openedAtMs: number;
  fundingAppliedThroughMs: number;
  fundingAccrued: Big;
  fundingPaymentsCollected: number;
  borrowCostAccrued: Big;
  lastBorrowAccrualMs: number;
  initialCapital: Big;
  liquidationInput: DeltaNeutralLiquidationInput;
  perpBankruptcyPrice: Big;
}

// ---------------------------------------------------------------------------
// DB read helpers — every one bounded `fetched_at <= T` (see module doc comment)
// ---------------------------------------------------------------------------

async function getTickTimestamps(db: Kysely<Database>, start: Date, end: Date): Promise<Date[]> {
  const rows = await db
    .selectFrom("tickers")
    .select("fetched_at")
    .distinct()
    .where("fetched_at", ">=", start)
    .where("fetched_at", "<=", end)
    .orderBy("fetched_at", "asc")
    .execute();
  return rows.map((r) => r.fetched_at);
}

async function latestTickerAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  category: "linear" | "spot",
  t: Date,
): Promise<TickerSnapshot | undefined> {
  const row = await db
    .selectFrom("tickers")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("category", "=", category)
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    lastPrice: new Big(row.last_price),
    markPrice: row.mark_price !== null ? new Big(row.mark_price) : null,
    turnover24h: row.turnover_24h !== null ? new Big(row.turnover_24h) : new Big(0),
  };
}

async function latestPredictedFundingAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  t: Date,
): Promise<PredictedFunding | undefined> {
  const row = await db
    .selectFrom("funding_rates")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("kind", "=", "predicted")
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    rate: new Big(row.rate),
    intervalMinutes: row.interval_minutes,
    nextFundingTimeMs: Number(row.funding_timestamp_ms),
  };
}

/**
 * kind='settled' rows, gated by `funding_timestamp_ms` (the real settlement
 * instant), NOT `fetched_at` (when the historical-sweep collector happened to
 * record it) — see module doc comment's "LOOK-AHEAD DISCIPLINE" section for why
 * this is the one deliberate exception to the usual `fetched_at <= T` rule.
 */
async function settledFundingSince(
  db: Kysely<Database>,
  symbol: string,
  afterMsExclusive: number,
  uptoMsInclusive: number,
): Promise<SettledFunding[]> {
  const rows = await db
    .selectFrom("funding_rates")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("kind", "=", "settled")
    .where("funding_timestamp_ms", ">", String(afterMsExclusive))
    .where("funding_timestamp_ms", "<=", String(uptoMsInclusive))
    .orderBy("funding_timestamp_ms", "asc")
    .execute();
  return rows.map((r) => ({
    rate: new Big(r.rate),
    intervalMinutes: r.interval_minutes,
    fundingTimestampMs: Number(r.funding_timestamp_ms),
  }));
}

async function orderbookSideAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  category: "linear" | "spot",
  side: "bid" | "ask",
  t: Date,
): Promise<OrderbookLevel[]> {
  const maxRow = await db
    .selectFrom("orderbook_levels")
    .select(({ fn }) => fn.max("fetched_at").as("maxFetchedAt"))
    .where("symbol", "=", symbol)
    .where("category", "=", category)
    .where("side", "=", side)
    .where("fetched_at", "<=", t)
    .executeTakeFirst();
  if (!maxRow || maxRow.maxFetchedAt === null) return [];

  const rows = await db
    .selectFrom("orderbook_levels")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("category", "=", category)
    .where("side", "=", side)
    .where("fetched_at", "=", maxRow.maxFetchedAt)
    .orderBy("level_index", "asc")
    .execute();
  return rows.map((r) => ({ price: new Big(r.price), qty: new Big(r.qty) }));
}

/**
 * Context-only market data for entry_reasoning (owner's ask, 2026-08-06: "что
 * происходило на рынке" at decision time) — same `fetched_at <= t` gate as
 * every other read in this file, but unlike latestPredictedFundingAtOrBefore
 * a missing row here does NOT veto the candidate: open_interest is collected
 * separately from tickers/funding_rates (collectOpenInterest.ts) and can
 * simply not have run yet for a given symbol/instant without that meaning
 * anything about whether the trade itself is sound.
 */
async function latestOpenInterestAtOrBefore(db: Kysely<Database>, symbol: string, t: Date): Promise<Big | undefined> {
  const row = await db
    .selectFrom("open_interest")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return new Big(row.open_interest);
}

/** Context-only, same reasoning as latestOpenInterestAtOrBefore above — collectLongShortRatio.ts's own sweep, never a veto input. */
async function latestLongShortRatioAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  t: Date,
): Promise<LongShortRatioSnapshot | undefined> {
  const row = await db
    .selectFrom("long_short_ratio")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return { buyRatio: new Big(row.buy_ratio), sellRatio: new Big(row.sell_ratio) };
}

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
async function pickBestCandidate(
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

// ---------------------------------------------------------------------------
// Position lifecycle
// ---------------------------------------------------------------------------

async function openNewPosition(
  db: Kysely<Database>,
  scenarioId: bigint,
  resolved: ResolvedScenarioConfig,
  t: Date,
  cand: CandidateEvaluation,
): Promise<OpenPositionState> {
  const spotFee = cand.spotQty.times(cand.spotPrice).times(resolved.spotTakerFeeRate);
  const perpFee = cand.perpQty.times(cand.perpMarkPrice).times(resolved.perpTakerFeeRate);

  const positionRow = await db
    .insertInto("paper_positions")
    .values({
      scenario_id: scenarioId,
      symbol: cand.symbol,
      state: "OPEN",
      spot_qty: cand.spotQty.toString(),
      perp_qty: cand.perpQty.toString(),
      leverage: resolved.leverage.toString(),
      entry_reasoning:
        `r8h=${cand.r8h.toString()} apr=${r8hToApr(cand.r8h).toString()} ` +
        `basis=${cand.currentBasis.toString()} perpNotional=${cand.legNotional.toString()} ` +
        `openInterest=${cand.openInterest?.toString() ?? "n/a"} ` +
        `lsrBuyRatio=${cand.longShortRatio?.buyRatio.toString() ?? "n/a"} ` +
        `lsrSellRatio=${cand.longShortRatio?.sellRatio.toString() ?? "n/a"}`,
      opened_at: t,
      closed_at: null, // explicit, though Kysely already treats a nullable plain field as optional at insert
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // PARAMS-CONSERVATIVE.md §6: "сначала шорт перпа, затем спот" — perp fill first.
  await db
    .insertInto("paper_fills")
    .values([
      {
        position_id: positionRow.id,
        leg: "perp",
        side: "Sell",
        qty: cand.perpQty.toString(),
        price: cand.perpMarkPrice.toString(),
        fee: perpFee.toString(),
        executed_at: t,
      },
      {
        position_id: positionRow.id,
        leg: "spot",
        side: "Buy",
        qty: cand.spotQty.toString(),
        price: cand.spotPrice.toString(),
        fee: spotFee.toString(),
        executed_at: t,
      },
    ])
    .execute();

  const perpEntryNotional = cand.perpQty.times(cand.perpMarkPrice);
  const spotEntryNotional = cand.spotQty.times(cand.spotPrice);
  const perpInitialMargin = perpEntryNotional.div(resolved.leverage);
  const initialCapital = spotEntryNotional.plus(perpInitialMargin);

  const liquidationInput: DeltaNeutralLiquidationInput = {
    perpEntryPrice: cand.perpMarkPrice,
    qty: cand.perpQty,
    leverage: resolved.leverage,
    tier: cand.tier,
    takerFeeRate: resolved.perpTakerFeeRate,
  };
  const { perpBankruptcyPrice } = computeDeltaNeutralPerpLegLiquidation(liquidationInput);

  return {
    id: positionRow.id,
    symbol: cand.symbol,
    spotQty: cand.spotQty,
    perpQty: cand.perpQty,
    leverage: resolved.leverage,
    spotEntryPrice: cand.spotPrice,
    perpEntryPrice: cand.perpMarkPrice,
    entryBasis: cand.currentBasis,
    entryApr: r8hToApr(cand.r8h),
    entryFees: spotFee.plus(perpFee),
    entrySpotSlippageBp: cand.entrySpotSlippageBp,
    entryPerpSlippageBp: cand.entryPerpSlippageBp,
    openedAtMs: t.getTime(),
    fundingAppliedThroughMs: t.getTime(),
    fundingAccrued: new Big(0),
    fundingPaymentsCollected: 0,
    borrowCostAccrued: new Big(0),
    lastBorrowAccrualMs: t.getTime(),
    initialCapital,
    liquidationInput,
    perpBankruptcyPrice,
  };
}

/** Applies every settled funding settlement up to (and including) T — see module doc comment. */
async function applySettledFundingUpTo(db: Kysely<Database>, pos: OpenPositionState, t: Date): Promise<void> {
  const rows = await settledFundingSince(db, pos.symbol, pos.fundingAppliedThroughMs, t.getTime());
  for (const row of rows) {
    const settleAt = new Date(row.fundingTimestampMs);
    // Price at the settlement instant, itself gated <= settleAt <= T — funding is
    // paid on the perp leg's notional at that instant (approximated via the
    // latest known mark price no later than settlement, since we don't have
    // minute-perfect price granularity at arbitrary settlement clock times).
    const priceAtSettlement = await latestTickerAtOrBefore(db, pos.symbol, "linear", settleAt);
    const markPrice = priceAtSettlement?.markPrice ?? pos.perpEntryPrice;
    // Short perp receives funding when rate > 0 (Bybit convention: longs pay shorts).
    const amount = row.rate.times(pos.perpQty).times(markPrice);

    pos.fundingAccrued = pos.fundingAccrued.plus(amount);
    pos.fundingPaymentsCollected += 1;
    pos.fundingAppliedThroughMs = row.fundingTimestampMs;

    await db
      .insertInto("paper_funding_payments")
      .values({
        position_id: pos.id,
        amount: amount.toString(),
        rate: row.rate.toString(),
        interval_minutes: row.intervalMinutes,
        paid_at: settleAt,
      })
      .execute();
  }
}

/** Auto-Borrow accrues hourly (emulation/borrowCost.ts) — discretized here per elapsed wall-clock time between ticks. */
function accrueBorrowCost(pos: OpenPositionState, t: Date, perpMarkPrice: Big, resolved: ResolvedScenarioConfig): void {
  const elapsedMs = t.getTime() - pos.lastBorrowAccrualMs;
  if (elapsedMs <= 0) return;
  const perpNotionalNow = pos.perpQty.times(perpMarkPrice);
  const rate8h = computeBorrowCost8h(pos.leverage, perpNotionalNow, resolved.hourlyBorrowRate);
  const increment = rate8h.times(perpNotionalNow).times(elapsedMs).div(EIGHT_HOURS_MS);
  pos.borrowCostAccrued = pos.borrowCostAccrued.plus(increment);
  pos.lastBorrowAccrualMs = t.getTime();
}

/**
 * Closes the position, journals the exit fills, and returns the cash
 * (initialCapital + realizedPnl - borrowCost) to return to the caller's
 * idle-cash pool. `reasonDetail` is a human-readable sentence explaining WHY
 * (owner's own words, 2026-08-06: "что, почему, из-за чего") — every call
 * site supplies one: strategy/exitRules.ts's own ExitDecision.reason for a
 * planned/emergency exit, or an explicit sentence for the two reasons that
 * don't come from checkExit (FORCED_LIQUIDATION, SCENARIO_END).
 */
async function closePosition(
  db: Kysely<Database>,
  pos: OpenPositionState,
  t: Date,
  exitPerpPrice: Big,
  exitSpotPrice: Big,
  reasonCode: string,
  reasonDetail: string,
  resolved: ResolvedScenarioConfig,
): Promise<Big> {
  const exitPerpFee = pos.perpQty.times(exitPerpPrice).times(resolved.perpTakerFeeRate);
  const exitSpotFee = pos.spotQty.times(exitSpotPrice).times(resolved.spotTakerFeeRate);

  await db
    .insertInto("paper_fills")
    .values([
      {
        position_id: pos.id,
        leg: "perp",
        side: "Buy",
        qty: pos.perpQty.toString(),
        price: exitPerpPrice.toString(),
        fee: exitPerpFee.toString(),
        executed_at: t,
      },
      {
        position_id: pos.id,
        leg: "spot",
        side: "Sell",
        qty: pos.spotQty.toString(),
        price: exitSpotPrice.toString(),
        fee: exitSpotFee.toString(),
        executed_at: t,
      },
    ])
    .execute();

  const entryLegNotional = pos.spotQty.times(pos.spotEntryPrice);
  const exitLegNotional = pos.spotQty.times(exitSpotPrice);
  const exitBasis = exitPerpPrice.minus(exitSpotPrice).div(exitSpotPrice);

  // Slippage charged as an explicit dollar cost (entry + exit legs), reusing the
  // entry-side bp estimate for the exit leg too — see module doc comment.
  const slippageCost = pos.entryPerpSlippageBp
    .times(pos.perpQty)
    .times(pos.perpEntryPrice.plus(exitPerpPrice))
    .plus(pos.entrySpotSlippageBp.times(pos.spotQty).times(pos.spotEntryPrice.plus(exitSpotPrice)));

  // Exit-time funding context for exit_reasoning — same latestPredictedFundingAtOrBefore
  // helper (and the same `fetched_at <= t` look-ahead gate) checkExit's own
  // predictedNextFundingRate input was built from, re-read here rather than
  // threaded through every call site so FORCED_LIQUIDATION/SCENARIO_END (which
  // never call checkExit at all) get the same context a planned exit does.
  const predictedAtExit = await latestPredictedFundingAtOrBefore(db, pos.symbol, t);
  const r8hAtExit = predictedAtExit
    ? normalizeFundingRateToR8h(predictedAtExit.rate, predictedAtExit.intervalMinutes)
    : undefined;
  const heldHours = ((t.getTime() - pos.openedAtMs) / (60 * 60 * 1000)).toFixed(2);

  const exitReasoning =
    `reasonCode=${reasonCode} r8hAtExit=${r8hAtExit?.toString() ?? "n/a"} ` +
    `aprAtExit=${r8hAtExit ? r8hToApr(r8hAtExit).toString() : "n/a"} basisAtExit=${exitBasis.toString()} ` +
    `exitPerpPrice=${exitPerpPrice.toString()} exitSpotPrice=${exitSpotPrice.toString()} ` +
    `heldHours=${heldHours} fundingPaymentsCollected=${String(pos.fundingPaymentsCollected)}` +
    (reasonCode === "FORCED_LIQUIDATION" ? ` liquidationPrice=${exitPerpPrice.toString()}` : "") +
    ` detail=${reasonDetail}`;

  // Persisted here (not just kept in-memory) so reportGenerator.ts can read back
  // the real per-trade cost instead of reporting an upper-bound net_pnl_usd —
  // see schema.ts's PaperPositionsTable doc comment for the stored sign convention.
  await db
    .updateTable("paper_positions")
    .set({
      state: "CLOSED",
      closed_at: t,
      slippage_cost: slippageCost.toString(),
      borrow_cost: pos.borrowCostAccrued.toString(),
      exit_reasoning: exitReasoning,
    })
    .where("id", "=", pos.id)
    .execute();

  const totalFees = pos.entryFees.plus(exitPerpFee).plus(exitSpotFee);

  const realizedPnl = computeRealizedPnl({
    entryLegNotional,
    exitLegNotional,
    entryBasis: pos.entryBasis,
    exitBasis,
    grossFundingCollected: pos.fundingAccrued,
    totalFees,
    realizedSlippage: slippageCost,
  });

  console.debug(
    `[scenarioRunner] closed position id=${pos.id.toString()} symbol=${pos.symbol} reason=${reasonCode} ` +
      `realizedPnl=${realizedPnl.toString()} fundingPayments=${String(pos.fundingPaymentsCollected)}`,
  );

  // realizedPnl.ts does not include borrow cost (a separate component, same as
  // equityEngine.ts's own breakdown) — subtracted here, separately.
  return pos.initialCapital.plus(realizedPnl).minus(pos.borrowCostAccrued);
}

interface TickOutcome {
  closed: boolean;
  cashReturned: Big;
  forced: boolean;
}

/** Applies funding/borrow accrual, then checks forced liquidation, then strategy exit rules, for one already-open position at tick T. */
async function processOpenPositionTick(
  db: Kysely<Database>,
  pos: OpenPositionState,
  t: Date,
  resolved: ResolvedScenarioConfig,
): Promise<TickOutcome> {
  const perpTicker = await latestTickerAtOrBefore(db, pos.symbol, "linear", t);
  const spotTicker = await latestTickerAtOrBefore(db, pos.symbol, "spot", t);

  if (!perpTicker || perpTicker.markPrice === null || !spotTicker) {
    // No fresh data for this symbol at/before T — position stays open untouched
    // this tick (mark-to-market/liquidation/exit all need a current price).
    return { closed: false, cashReturned: new Big(0), forced: false };
  }
  const perpMarkPrice = perpTicker.markPrice;
  const spotPrice = spotTicker.lastPrice;

  accrueBorrowCost(pos, t, perpMarkPrice, resolved);
  await applySettledFundingUpTo(db, pos, t);

  // emulation/liquidation.ts's simulateDeltaNeutralForcedLiquidation, called with
  // ONLY this tick's price — the same no-look-ahead discipline as every DB query
  // in this file: it never sees a later tick's price.
  const liqSim = simulateDeltaNeutralForcedLiquidation(
    [{ timestampMs: t.getTime(), markPrice: perpMarkPrice }],
    pos.liquidationInput,
  );
  if (liqSim.wasLiquidated) {
    const cashReturned = await closePosition(
      db,
      pos,
      t,
      pos.perpBankruptcyPrice,
      spotPrice,
      "FORCED_LIQUIDATION",
      "Perp leg forced-liquidated: emulation/liquidation.ts's simulateDeltaNeutralForcedLiquidation found this " +
        "tick's mark price breached the simulated maintenance-margin/bankruptcy threshold for the position's tier.",
      resolved,
    );
    return { closed: true, cashReturned, forced: true };
  }

  const predicted = await latestPredictedFundingAtOrBefore(db, pos.symbol, t);
  if (predicted) {
    const r8h = normalizeFundingRateToR8h(predicted.rate, predicted.intervalMinutes);
    const currentBasis = perpMarkPrice.minus(spotPrice).div(spotPrice);
    const exitDecision = checkExit({
      predictedNextFundingRate: r8h,
      currentApr: r8hToApr(r8h),
      entryApr: pos.entryApr,
      basisDivergence: currentBasis.abs(),
      isDelistedOrContractChanged: false,
      fundingPaymentsCollected: pos.fundingPaymentsCollected,
    });
    if (exitDecision.shouldExit) {
      const cashReturned = await closePosition(
        db,
        pos,
        t,
        perpMarkPrice,
        spotPrice,
        exitDecision.code,
        exitDecision.reason,
        resolved,
      );
      return { closed: true, cashReturned, forced: false };
    }
  }

  return { closed: false, cashReturned: new Big(0), forced: false };
}

// ---------------------------------------------------------------------------
// Equity snapshots
// ---------------------------------------------------------------------------

/** Writes one paper_equity_snapshots row and returns the (possibly updated) all-time peak equity. */
async function writeEquitySnapshot(
  db: Kysely<Database>,
  scenarioId: bigint,
  t: Date,
  pos: OpenPositionState | null,
  cashOutsidePosition: Big,
  peakEquity: Big,
): Promise<Big> {
  let totalEquity: Big;
  let marginBalance: Big;

  if (pos) {
    const perpTicker = await latestTickerAtOrBefore(db, pos.symbol, "linear", t);
    const spotTicker = await latestTickerAtOrBefore(db, pos.symbol, "spot", t);
    const perpMarkPrice = perpTicker?.markPrice ?? pos.perpEntryPrice;
    const spotMarkPrice = spotTicker?.lastPrice ?? pos.spotEntryPrice;

    const snap = computeEquitySnapshot({
      spotEntryPrice: pos.spotEntryPrice,
      perpEntryPrice: pos.perpEntryPrice,
      qty: pos.spotQty,
      spotMarkPrice,
      perpMarkPrice,
      leverage: pos.leverage,
      fundingAccrued: pos.fundingAccrued,
      borrowCostAccrued: pos.borrowCostAccrued,
    });
    totalEquity = cashOutsidePosition.plus(snap.totalEquity);
    // margin_balance approximation — see module doc comment.
    const spotLegNotionalNow = pos.spotQty.times(spotMarkPrice);
    marginBalance = totalEquity.minus(spotLegNotionalNow);
  } else {
    totalEquity = cashOutsidePosition;
    marginBalance = cashOutsidePosition;
  }

  const isPeak = totalEquity.gte(peakEquity);

  await db
    .insertInto("paper_equity_snapshots")
    .values({
      scenario_id: scenarioId,
      at: t,
      total_equity: totalEquity.toString(),
      margin_balance: marginBalance.toString(),
      is_peak: isPeak,
    })
    .execute();

  return isPeak ? totalEquity : peakEquity;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function validateConfig(config: ScenarioConfig): void {
  if (config.leverage.lt(1)) {
    throw new RangeError(
      `leverage must be >= 1 (1.0 = fully self-funded, no borrowing), got ${config.leverage.toString()}`,
    );
  }
  if (config.startingDeposit.lte(0)) {
    throw new RangeError(`startingDeposit must be positive, got ${config.startingDeposit.toString()}`);
  }
  if (config.symbols.length === 0) {
    throw new RangeError("symbols must be a non-empty list");
  }
  if (config.startAt.getTime() >= config.endAt.getTime()) {
    throw new RangeError(`startAt (${config.startAt.toISOString()}) must be before endAt (${config.endAt.toISOString()})`);
  }
}

function resolveConfig(config: ScenarioConfig): ResolvedScenarioConfig {
  return {
    leverage: config.leverage,
    symbols: config.symbols,
    perpQtyStepBySymbol: config.perpQtyStepBySymbol ?? {},
    hourlyBorrowRate: config.hourlyBorrowRate ?? HOURLY_BORROW_RATE_FALLBACK,
    spotTakerFeeRate: config.spotTakerFeeRate ?? SPOT_TAKER_FEE_RATE_FALLBACK,
    perpTakerFeeRate: config.perpTakerFeeRate ?? PERP_TAKER_FEE_RATE_FALLBACK,
    positionSizeUsd: config.positionSizeUsd,
  };
}

async function executeScenario(
  db: Kysely<Database>,
  scenarioId: bigint,
  config: ScenarioConfig,
  resolved: ResolvedScenarioConfig,
): Promise<ScenarioRunResult> {
  const ticks = await getTickTimestamps(db, config.startAt, config.endAt);

  let cashOutsidePosition = config.startingDeposit;
  let peakEquity = config.startingDeposit;
  let openPosition: OpenPositionState | null = null;
  let paperState: PaperPositionState = "IDLE";
  let positionsOpened = 0;
  let positionsClosed = 0;
  // Owner's own sizing rule (2026-08-07, see module doc comment): small with
  // no track record or after a significant loss, larger after a run of
  // wins. This scenario's OWN closed-trade history, oldest first — fed into
  // adaptivePositionSizing.ts's pure fold before every entry decision below.
  const closedTradeHistory: TradeOutcome[] = [];

  for (const t of ticks) {
    if (openPosition) {
      const outcome = await processOpenPositionTick(db, openPosition, t, resolved);
      if (outcome.closed) {
        // Net of borrow cost, not raw realizedPnl.ts output — "did this trade
        // net make money" (cashReturned vs. what left the idle-cash pool to
        // open it) is what should drive the next sizing decision, not gross
        // P&L before the drag that leverage scenarios specifically add.
        closedTradeHistory.push({
          realizedPnl: outcome.cashReturned.minus(openPosition.initialCapital),
          equityAtClose: cashOutsidePosition.plus(outcome.cashReturned),
        });
        cashOutsidePosition = cashOutsidePosition.plus(outcome.cashReturned);
        paperState = transition(paperState, outcome.forced ? "RISK_FORCE_CLOSE" : "STRATEGY_EXIT_APPROVED");
        paperState = transition(paperState, "BOTH_LEGS_CLOSED");
        paperState = transition(paperState, "JOURNALED");
        openPosition = null;
        positionsClosed++;
      }
    }

    // RR-22: only ever evaluated while flat — see module doc comment.
    if (!openPosition && cashOutsidePosition.gt(0)) {
      const sizeFraction = computeNextPositionSizeFraction(closedTradeHistory);
      const winner = await pickBestCandidate(db, resolved, t, cashOutsidePosition, sizeFraction);
      if (winner) {
        paperState = transition(paperState, "INTENT_RECORDED");
        openPosition = await openNewPosition(db, scenarioId, resolved, t, winner);
        paperState = transition(paperState, "BOTH_LEGS_OPENED");
        cashOutsidePosition = cashOutsidePosition.minus(openPosition.initialCapital);
        positionsOpened++;
      }
    }

    peakEquity = await writeEquitySnapshot(db, scenarioId, t, openPosition, cashOutsidePosition, peakEquity);
  }

  // Never leave a position open at the end of the range.
  if (openPosition) {
    const lastT = ticks[ticks.length - 1];
    if (lastT) {
      const perpTicker = await latestTickerAtOrBefore(db, openPosition.symbol, "linear", lastT);
      const spotTicker = await latestTickerAtOrBefore(db, openPosition.symbol, "spot", lastT);
      const perpExitPrice = perpTicker?.markPrice ?? openPosition.perpEntryPrice;
      const spotExitPrice = spotTicker?.lastPrice ?? openPosition.spotEntryPrice;

      const cashReturned = await closePosition(
        db,
        openPosition,
        lastT,
        perpExitPrice,
        spotExitPrice,
        "SCENARIO_END",
        "Scenario date range ended with the position still open — force-closed at the last tick so no paper " +
          "position outlives its own run (never a strategy or risk decision).",
        resolved,
      );
      closedTradeHistory.push({
        realizedPnl: cashReturned.minus(openPosition.initialCapital),
        equityAtClose: cashOutsidePosition.plus(cashReturned),
      });
      cashOutsidePosition = cashOutsidePosition.plus(cashReturned);
      paperState = transition(paperState, "STRATEGY_EXIT_APPROVED");
      paperState = transition(paperState, "BOTH_LEGS_CLOSED");
      paperState = transition(paperState, "JOURNALED");
      openPosition = null;
      positionsClosed++;

      peakEquity = await writeEquitySnapshot(db, scenarioId, lastT, null, cashOutsidePosition, peakEquity);
    }
  }

  return {
    scenarioId,
    ticksProcessed: ticks.length,
    positionsOpened,
    positionsClosed,
    finalEquity: cashOutsidePosition,
  };
}

/**
 * Runs ONE Фаза-2 paper-trading scenario end to end over real historical market
 * data already in the DB, and journals the result into paper_scenarios/
 * paper_positions/paper_fills/paper_funding_payments/paper_equity_snapshots.
 * See this module's own top-level doc comment for the look-ahead discipline and
 * RR-22 (max one position) guarantees this function depends on.
 */
export async function runScenario(db: Kysely<Database>, config: ScenarioConfig): Promise<ScenarioRunResult> {
  validateConfig(config);
  const resolved = resolveConfig(config);

  const scenarioRow = await db
    .insertInto("paper_scenarios")
    .values({
      name: config.name,
      leverage: config.leverage.toString(),
      starting_deposit: config.startingDeposit.toString(),
      status: "running",
      started_at: new Date(),
      stopped_at: null, // explicit, though Kysely already treats a nullable plain field as optional at insert
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const scenarioId = scenarioRow.id;

  try {
    const result = await executeScenario(db, scenarioId, config, resolved);
    await db
      .updateTable("paper_scenarios")
      .set({ status: "completed", stopped_at: new Date() })
      .where("id", "=", scenarioId)
      .execute();
    return result;
  } catch (e) {
    await db
      .updateTable("paper_scenarios")
      .set({ status: "failed", stopped_at: new Date() })
      .where("id", "=", scenarioId)
      .execute();
    throw e;
  }
}
