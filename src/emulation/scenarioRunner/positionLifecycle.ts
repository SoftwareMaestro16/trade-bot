import Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { normalizeFundingRateToR8h, r8hToApr } from "../../market-data/normalizeFunding.js";
import { computeRealizedPnl } from "../../execution/realizedPnl.js";
import { computeDeltaNeutralPerpLegLiquidation } from "../liquidation.js";
import type { DeltaNeutralLiquidationInput } from "../liquidation.js";
import { latestPredictedFundingAtOrBefore } from "./dbReaders.js";
import type { ResolvedScenarioConfig, CandidateEvaluation, OpenPositionState } from "./types.js";

/**
 * scenarioRunner split (mechanical refactor): position open/close mechanics —
 * openNewPosition (journals the entry fills and derives the position's
 * liquidation input) and closePosition (journals the exit fills and returns
 * realized cash). Per-tick accrual/exit-check logic that operates on an
 * already-open position lives in ./tickProcessing.ts instead.
 */

// ---------------------------------------------------------------------------
// Position lifecycle
// ---------------------------------------------------------------------------

export async function openNewPosition(
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
    lastSettledIntervalMinutes: undefined,
    fundingGapDetected: false,
    borrowCostAccrued: new Big(0),
    lastBorrowAccrualMs: t.getTime(),
    initialCapital,
    liquidationInput,
    perpBankruptcyPrice,
  };
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
export async function closePosition(
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
  // helper (now in ./dbReaders.ts) (and the same `fetched_at <= t` look-ahead gate) checkExit's own
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
    `heldHours=${heldHours} fundingPaymentsCollected=${String(pos.fundingPaymentsCollected)} ` +
    // See applySettledFundingUpTo's doc comment (now in ./tickProcessing.ts): true means a gap consistent with
    // collectSettledFunding.ts's documented silent-drop scenarios was suspected
    // during this hold — this position's funding P&L may be understated.
    `fundingGapDetected=${String(pos.fundingGapDetected)}` +
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
