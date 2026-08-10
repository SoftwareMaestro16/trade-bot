import Big from "big.js";
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
  positions: readonly OpenPositionState[],
  cashOutsidePosition: Big,
  peakEquity: Big,
): Promise<{ peakEquity: Big; totalEquity: Big }> {
  // Every open position contributes its own mark-to-market equity and its own
  // spot-leg notional; both sums fold over the list so a one-slot run produces
  // byte-identical numbers to the pre-parallel single-position code (the empty
  // list collapses to cashOutsidePosition, exactly as the old `else` branch).
  let totalEquity = cashOutsidePosition;
  let spotLegNotionalNow = new Big(0);

  for (const pos of positions) {
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
    totalEquity = totalEquity.plus(snap.totalEquity);
    spotLegNotionalNow = spotLegNotionalNow.plus(pos.spotQty.times(spotMarkPrice));
  }

  // margin_balance approximation — see module doc comment.
  const marginBalance = totalEquity.minus(spotLegNotionalNow);

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
    maxConcurrentPositions: config.maxConcurrentPositions ?? 1,
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
  // RR-22 caps this at 1 by default (resolveConfig), which is what production
  // still enforces. Held as a list so a sweep can raise the cap and measure
  // whether extra slots earn anything — the constraint that made this worth
  // building is that the strategy sat flat ~91% of the time with one slot,
  // and slots only help if several symbols clear the veto chain at once.
  const openPositions: OpenPositionState[] = [];
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
    // Iterated back-to-front so a close can splice in place without shifting
    // an index that has not been visited yet.
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      if (!pos) continue; // satisfies noUncheckedIndexedAccess
      const outcome = await processOpenPositionTick(db, pos, t, resolved);
      if (outcome.closed) {
        // Net of borrow cost, not raw realizedPnl.ts output — "did this trade
        // net make money" (cashReturned vs. what left the idle-cash pool to
        // open it) is what should drive the next sizing decision, not gross
        // P&L before the drag that leverage scenarios specifically add.
        closedTradeHistory.push({
          realizedPnl: outcome.cashReturned.minus(pos.initialCapital),
          equityAtClose: cashOutsidePosition.plus(outcome.cashReturned),
        });
        cashOutsidePosition = cashOutsidePosition.plus(outcome.cashReturned);
        paperState = transition(paperState, outcome.forced ? "RISK_FORCE_CLOSE" : "STRATEGY_EXIT_APPROVED");
        paperState = transition(paperState, "BOTH_LEGS_CLOSED");
        paperState = transition(paperState, "JOURNALED");
        openPositions.splice(i, 1);
        positionsClosed++;
      }
    }

    // Gated on !drawdownHalted — PARAMS-CONSERVATIVE.md §9: a drawdown breach
    // means "стоп до ручного рестарта", not "close positions and keep trading."
    //
    // Loops so several slots can be filled on the SAME tick: with one slot the
    // loop body runs at most once and this is exactly the old behaviour. Each
    // pass re-evaluates against the shrinking cash pool, so slot N is sized
    // against what slot N-1 actually left behind rather than against the
    // pre-entry balance — otherwise filling k slots would commit k times the
    // capital the sizing rule authorised once.
    //
    // Already-held symbols are excluded rather than deduplicated afterward:
    // two positions in the same coin is not diversification, it is one
    // double-sized position wearing a disguise, and it would slip past
    // checkConcentration (which sees each leg separately).
    while (
      openPositions.length < resolved.maxConcurrentPositions &&
      !drawdownHalted &&
      cashOutsidePosition.gt(0)
    ) {
      const sizeFraction = computeNextPositionSizeFraction(closedTradeHistory);
      const heldSymbols = new Set(openPositions.map((p) => p.symbol));
      const winner = await pickBestCandidate(db, resolved, t, cashOutsidePosition, sizeFraction, heldSymbols);
      if (!winner) break;

      // Affordability guard. With equity-fraction sizing each successive slot
      // is naturally smaller (it is a fraction of the SHRINKING cash pool), so
      // this never binds. With a FIXED positionSizeUsd it binds immediately:
      // every slot would demand the same capital regardless of what is left,
      // and slot 2 of a $400-notional config on a $1000 deposit would overdraw
      // the account into negative cash — which then silently poisons every
      // downstream percentage, since equity is the denominator everywhere.
      const projectedCapital = winner.spotQty
        .times(winner.spotPrice)
        .plus(winner.perpQty.times(winner.perpMarkPrice).div(resolved.leverage));
      if (projectedCapital.gt(cashOutsidePosition)) break;

      paperState = transition(paperState, "INTENT_RECORDED");
      const opened = await openNewPosition(db, scenarioId, resolved, t, winner);
      paperState = transition(paperState, "BOTH_LEGS_OPENED");
      cashOutsidePosition = cashOutsidePosition.minus(opened.initialCapital);
      openPositions.push(opened);
      positionsOpened++;
    }

    const snapshot = await writeEquitySnapshot(db, scenarioId, t, openPositions, cashOutsidePosition, peakEquity);
    peakEquity = snapshot.peakEquity;

    // RR-40/41/42, PARAMS-CONSERVATIVE.md §8/§9: checked every tick, not just
    // at scenario end — a real drawdown-triggered stop must fire the moment
    // it's crossed, not get discovered only when the report is generated
    // afterward.
    const drawdownResult = checkDrawdown(snapshot.totalEquity, peakEquity);
    if (!drawdownHalted && !drawdownResult.allowed) {
      drawdownHalted = true;
      // Every slot, not just one: §9's "стоп" is an account-level stop, and
      // leaving sibling positions open after a drawdown breach would keep
      // exactly the exposure the rule exists to remove.
      while (openPositions.length > 0) {
        const pos = openPositions.pop();
        if (!pos) break; // satisfies noUncheckedIndexedAccess
        const cashReturned = await forceClosePosition(
          db,
          pos,
          t,
          "DRAWDOWN_EXCEEDED",
          `${drawdownResult.reason} Force-closed and halting new entries for the rest of this scenario ` +
            '(PARAMS-CONSERVATIVE.md §9: "стоп до ручного рестарта").',
          resolved,
        );
        closedTradeHistory.push({
          realizedPnl: cashReturned.minus(pos.initialCapital),
          equityAtClose: cashOutsidePosition.plus(cashReturned),
        });
        cashOutsidePosition = cashOutsidePosition.plus(cashReturned);
        paperState = transition(paperState, "RISK_FORCE_CLOSE");
        paperState = transition(paperState, "BOTH_LEGS_CLOSED");
        paperState = transition(paperState, "JOURNALED");
        positionsClosed++;
      }
    }
  }

  // Never leave a position open at the end of the range.
  if (openPositions.length > 0) {
    const lastT = ticks[ticks.length - 1];
    if (lastT) {
      while (openPositions.length > 0) {
        const pos = openPositions.pop();
        if (!pos) break; // satisfies noUncheckedIndexedAccess
        const cashReturned = await forceClosePosition(
          db,
          pos,
          lastT,
          "SCENARIO_END",
          "Scenario date range ended with the position still open — force-closed at the last tick so no paper " +
            "position outlives its own run (never a strategy or risk decision).",
          resolved,
        );
        closedTradeHistory.push({
          realizedPnl: cashReturned.minus(pos.initialCapital),
          equityAtClose: cashOutsidePosition.plus(cashReturned),
        });
        cashOutsidePosition = cashOutsidePosition.plus(cashReturned);
        paperState = transition(paperState, "STRATEGY_EXIT_APPROVED");
        paperState = transition(paperState, "BOTH_LEGS_CLOSED");
        paperState = transition(paperState, "JOURNALED");
        positionsClosed++;
      }

      await writeEquitySnapshot(db, scenarioId, lastT, [], cashOutsidePosition, peakEquity);
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
