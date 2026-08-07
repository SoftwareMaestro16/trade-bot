import type Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { computeEquitySnapshot } from "../equityEngine.js";
import { computeNextPositionSizeFraction } from "../adaptivePositionSizing.js";
import type { TradeOutcome } from "../adaptivePositionSizing.js";
import { transition } from "../paperPositionState.js";
import type { PaperPositionState } from "../paperPositionState.js";
import { getTickTimestamps, latestTickerAtOrBefore } from "./dbReaders.js";
import { pickBestCandidate } from "./candidateSelection.js";
import { openNewPosition, closePosition } from "./positionLifecycle.js";
import { processOpenPositionTick } from "./tickProcessing.js";
import { HOURLY_BORROW_RATE_FALLBACK, SPOT_TAKER_FEE_RATE_FALLBACK, PERP_TAKER_FEE_RATE_FALLBACK } from "./types.js";
import type { ScenarioConfig, ScenarioRunResult, ResolvedScenarioConfig, OpenPositionState } from "./types.js";

/**
 * scenarioRunner split (mechanical refactor): the orchestrator — equity
 * snapshots (writeEquitySnapshot) and the top-level driver
 * (validateConfig/resolveConfig/executeScenario/runScenario) that ties every
 * other scenarioRunner/ sub-file together into the actual replay loop. See
 * the barrel's module doc comment (../../emulation/scenarioRunner.ts) for
 * the look-ahead discipline and RR-22 guarantees this depends on.
 */

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
