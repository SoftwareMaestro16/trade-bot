import Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { checkExit } from "../../strategy/exitRules.js";
import { normalizeFundingRateToR8h, r8hToApr } from "../../market-data/normalizeFunding.js";
import { computeBorrowCost8h } from "../borrowCost.js";
import { simulateDeltaNeutralForcedLiquidation } from "../liquidation.js";
import { settledFundingSince, latestTickerAtOrBefore, latestPredictedFundingAtOrBefore } from "./dbReaders.js";
import { closePosition } from "./positionLifecycle.js";
import { EIGHT_HOURS_MS } from "./types.js";
import type { ResolvedScenarioConfig, OpenPositionState } from "./types.js";

/**
 * scenarioRunner split (mechanical refactor): per-tick position processing —
 * everything that happens to an already-open position at one tick T:
 * funding/borrow accrual (applySettledFundingUpTo, accrueBorrowCost), then
 * forced-liquidation and strategy-exit checks (processOpenPositionTick).
 * Open/close mechanics themselves live in ./positionLifecycle.ts.
 */

/**
 * Applies every settled funding settlement up to (and including) T — see module doc comment.
 *
 * Gap detection: `settledFundingSince` is a plain time-range SELECT over
 * kind='settled' rows with no completeness guarantee — collectSettledFunding.ts's
 * own doc comment documents realistic scenarios (a symbol's first poll keeping only
 * its 5 most recent settlements via `limit:5`/no `startTime`; an outage exceeding
 * the `limit:200` catch-up window) where an individual settlement row is silently,
 * permanently dropped and never revisited. Trusting whatever comes back as a
 * complete record would then silently understate/misstate this position's funding
 * P&L with no error or flag anywhere downstream. Flagged (not thrown/skipped, so
 * one bad symbol doesn't abort an entire scenario run) whenever the elapsed time
 * since the last-applied settlement exceeds a generous multiple of that prior
 * settlement's own cadence — only once at least one real settlement has already
 * been applied to this position, since `fundingAppliedThroughMs` at position-open
 * is the OPEN time, not a settlement boundary, so the very first settlement's
 * elapsed-since-open is expected to be at most one interval and must not trip this.
 */
const FUNDING_GAP_TOLERANCE_FACTOR = 1.5;

async function applySettledFundingUpTo(db: Kysely<Database>, pos: OpenPositionState, t: Date): Promise<void> {
  const rows = await settledFundingSince(db, pos.symbol, pos.fundingAppliedThroughMs, t.getTime());
  for (const row of rows) {
    if (pos.fundingPaymentsCollected > 0 && pos.lastSettledIntervalMinutes !== undefined) {
      const elapsedMs = row.fundingTimestampMs - pos.fundingAppliedThroughMs;
      const expectedMaxMs = pos.lastSettledIntervalMinutes * 60_000 * FUNDING_GAP_TOLERANCE_FACTOR;
      if (elapsedMs > expectedMaxMs) {
        pos.fundingGapDetected = true;
        console.warn(
          `[scenarioRunner] FUNDING GAP suspected symbol=${pos.symbol} positionId=${pos.id.toString()} ` +
            `lastAppliedMs=${pos.fundingAppliedThroughMs} nextRowMs=${row.fundingTimestampMs} elapsedMs=${elapsedMs} ` +
            `expectedIntervalMinutes=${pos.lastSettledIntervalMinutes} — collectSettledFunding.ts may have silently ` +
            `dropped a settlement row in between (see that file's doc comment); reported funding P&L for this ` +
            `position may be understated.`,
        );
      }
    }
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
    pos.lastSettledIntervalMinutes = row.intervalMinutes;

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

export interface TickOutcome {
  closed: boolean;
  cashReturned: Big;
  forced: boolean;
}

/** Applies funding/borrow accrual, then checks forced liquidation, then strategy exit rules, for one already-open position at tick T. */
export async function processOpenPositionTick(
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
