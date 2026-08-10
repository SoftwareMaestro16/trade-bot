import type Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { computeEquitySnapshot } from "../equityEngine.js";
import { computeNextPositionSizeFraction } from "../adaptivePositionSizing.js";
import type { TradeOutcome } from "../adaptivePositionSizing.js";
import { transition } from "../paperPositionState.js";
import type { PaperPositionState } from "../paperPositionState.js";
import { checkDrawdown } from "../../risk/drawdown.js";
import { getTickTimestamps, latestTickerAtOrBefore } from "./dbReaders.js";
import { pickBestCandidate } from "./candidateSelection.js";
import { openNewPosition, closePosition } from "./positionLifecycle.js";
import { processOpenPositionTick } from "./tickProcessing.js";
import { HOURLY_BORROW_RATE_FALLBACK, SPOT_TAKER_FEE_RATE_FALLBACK, PERP_TAKER_FEE_RATE_FALLBACK, EXPECTED_PAYBACK_MINUTES } from "./types.js";
import type { ScenarioConfig, ScenarioRunResult, ResolvedScenarioConfig, OpenPositionState } from "./types.js";
import { DEFAULT_RISK_THRESHOLDS } from "../../risk/index.js";

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

/**
 * Writes one paper_equity_snapshots row and returns both the (possibly
 * updated) all-time peak equity and this tick's own total equity — the
 * latter is what executeScenario's drawdown check (RR-40/41/42,
 * PARAMS-CONSERVATIVE.md §8) compares against the former.
 */
async function writeEquitySnapshot(
  db: Kysely<Database>,
  scenarioId: bigint,
  t: Date,
  pos: OpenPositionState | null,
  cashOutsidePosition: Big,
  peakEquity: Big,
): Promise<{ peakEquity: Big; totalEquity: Big }> {
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

  return { peakEquity: isPeak ? totalEquity : peakEquity, totalEquity };
}

/**
 * Force-closes `pos` at the latest available mark price (falling back to its
 * own entry price if no fresher ticker exists) and returns the cash proceeds.
 * Shared by both forced-close sites (drawdown breach mid-run, and the
 * unconditional end-of-range close below) so they can't silently drift out
 * of sync on how "current price" is resolved.
 */
async function forceClosePosition(
  db: Kysely<Database>,
  pos: OpenPositionState,
  t: Date,
  reasonCode: string,
  reasonDetail: string,
  resolved: ResolvedScenarioConfig,
): Promise<Big> {
  const perpTicker = await latestTickerAtOrBefore(db, pos.symbol, "linear", t);
  const spotTicker = await latestTickerAtOrBefore(db, pos.symbol, "spot", t);
  const perpExitPrice = perpTicker?.markPrice ?? pos.perpEntryPrice;
  const spotExitPrice = spotTicker?.lastPrice ?? pos.spotEntryPrice;
  return closePosition(db, pos, t, perpExitPrice, spotExitPrice, reasonCode, reasonDetail, resolved);
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
    riskThresholds: { ...DEFAULT_RISK_THRESHOLDS, ...config.riskThresholds },
    expectedPaybackMinutes: config.expectedPaybackMinutes ?? EXPECTED_PAYBACK_MINUTES,
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
  // PARAMS-CONSERVATIVE.md §8/§9: "Просадка выше 3% -> закрыть всё по рынку,
  // стоп до ручного рестарта" — once tripped, no new entries for the REST of
  // this run (peak is never auto-reset; a scenario run has no "manual
  // restart" concept, so the halt simply persists to the end of the range).
  // Found missing 2026-08-08 by a risk-register-enforcement audit:
  // checkDrawdown (risk/drawdown.ts) was correctly implemented and unit
  // tested but never actually called anywhere in this live tick loop —
  // reportGenerator's computeMaxDrawdownPct only computes it AFTER the fact
  // for the report, which cannot and does not stop anything.
  let drawdownHalted = false;
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

    // RR-22: only ever evaluated while flat. Also gated on !drawdownHalted —
    // PARAMS-CONSERVATIVE.md §9: a drawdown breach means "стоп до ручного
    // рестарта", not "close this one position and keep trading."
    if (!openPosition && !drawdownHalted && cashOutsidePosition.gt(0)) {
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

    const snapshot = await writeEquitySnapshot(db, scenarioId, t, openPosition, cashOutsidePosition, peakEquity);
    peakEquity = snapshot.peakEquity;

    // RR-40/41/42, PARAMS-CONSERVATIVE.md §8/§9: checked every tick, not just
    // at scenario end — a real drawdown-triggered stop must fire the moment
    // it's crossed, not get discovered only when the report is generated
    // afterward.
    const drawdownResult = checkDrawdown(snapshot.totalEquity, peakEquity);
    if (!drawdownHalted && !drawdownResult.allowed) {
      drawdownHalted = true;
      if (openPosition) {
        const cashReturned = await forceClosePosition(
          db,
          openPosition,
          t,
          "DRAWDOWN_EXCEEDED",
          `${drawdownResult.reason} Force-closed and halting new entries for the rest of this scenario ` +
            '(PARAMS-CONSERVATIVE.md §9: "стоп до ручного рестарта").',
          resolved,
        );
        closedTradeHistory.push({
          realizedPnl: cashReturned.minus(openPosition.initialCapital),
          equityAtClose: cashOutsidePosition.plus(cashReturned),
        });
        cashOutsidePosition = cashOutsidePosition.plus(cashReturned);
        paperState = transition(paperState, "RISK_FORCE_CLOSE");
        paperState = transition(paperState, "BOTH_LEGS_CLOSED");
        paperState = transition(paperState, "JOURNALED");
        openPosition = null;
        positionsClosed++;
      }
    }
  }

  // Never leave a position open at the end of the range.
  if (openPosition) {
    const lastT = ticks[ticks.length - 1];
    if (lastT) {
      const cashReturned = await forceClosePosition(
        db,
        openPosition,
        lastT,
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

      await writeEquitySnapshot(db, scenarioId, lastT, null, cashOutsidePosition, peakEquity);
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
