import Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { computeRealizedPnlBreakdown } from "../../execution/realizedPnl.js";
import {
  bigSum,
  groupBy,
  parseReasoningText,
  MS_PER_HOUR,
  type EquitySnapshotPoint,
  type ScenarioActivity,
  type ScenarioRow,
  type TradeRow,
} from "./shared.js";

// DB-reads sub-file of ../reportGenerator.ts — see that file's module doc
// comment for the full picture (sign convention, slippage/borrow-cost
// sourcing, etc). This file is DB-reads-only, same guarantee as the parent
// module.

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

export async function fetchScenarios(db: Kysely<Database>, scenarioIds: bigint[]): Promise<ScenarioRow[]> {
  const rows = await db.selectFrom("paper_scenarios").selectAll().where("id", "in", scenarioIds).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return scenarioIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new RangeError(`generateReports: paper_scenarios.id=${id.toString()} not found (requested in scenarioIds)`);
    }
    return row;
  });
}

export async function fetchClosedTrades(db: Kysely<Database>, scenario: ScenarioRow): Promise<TradeRow[]> {
  const positions = await db
    .selectFrom("paper_positions")
    .selectAll()
    .where("scenario_id", "=", scenario.id)
    .where("state", "=", "CLOSED")
    .where("closed_at", "is not", null)
    .orderBy("opened_at", "asc")
    .orderBy("id", "asc")
    .execute();

  const positionIds = positions.map((p) => p.id);

  const fills =
    positionIds.length > 0
      ? await db.selectFrom("paper_fills").selectAll().where("position_id", "in", positionIds).execute()
      : [];
  const funding =
    positionIds.length > 0
      ? await db.selectFrom("paper_funding_payments").selectAll().where("position_id", "in", positionIds).execute()
      : [];

  const fillsByPosition = groupBy(fills, (f) => f.position_id);
  const fundingByPosition = groupBy(funding, (f) => f.position_id);

  return positions.map((position) => {
    const positionFills = fillsByPosition.get(position.id) ?? [];
    const positionFunding = fundingByPosition.get(position.id) ?? [];
    return buildTradeRow(scenario, position, positionFills, positionFunding);
  });
}

function buildTradeRow(
  scenario: ScenarioRow,
  position: {
    id: bigint;
    symbol: string;
    leverage: string;
    spot_qty: string | null;
    perp_qty: string | null;
    opened_at: Date | null;
    closed_at: Date | null;
    slippage_cost: string | null;
    borrow_cost: string | null;
    entry_reasoning: string | null;
    exit_reasoning: string | null;
  },
  fills: { leg: "spot" | "perp"; side: string; qty: string; price: string; fee: string; executed_at: Date }[],
  fundingPayments: { amount: string }[],
): TradeRow {
  if (position.opened_at === null || position.closed_at === null) {
    // Guarded by the `state = 'CLOSED' AND closed_at IS NOT NULL` query above
    // — reaching here means the two disagree, a data-integrity problem worth
    // failing loudly on rather than silently reporting a bogus trade row.
    throw new Error(`paper_positions.id=${position.id.toString()} is CLOSED but opened_at/closed_at is null`);
  }
  if (position.spot_qty === null || position.perp_qty === null) {
    throw new Error(`paper_positions.id=${position.id.toString()} is CLOSED but spot_qty/perp_qty is null`);
  }
  if (position.slippage_cost === null || position.borrow_cost === null) {
    throw new Error(`paper_positions.id=${position.id.toString()} is CLOSED but slippage_cost/borrow_cost is null`);
  }

  // Matched by (leg, side), not by array position/timestamp — scenarioRunner.ts
  // hardcodes exactly these four (leg, side) pairs for every open/close, and a
  // position force-closed on the SAME tick it opened (the "never leave a
  // position open at range end" branch, when the winning candidate is found on
  // the very last tick) has opened_at === closed_at, making timestamp-based
  // matching ambiguous where (leg, side) is not.
  const entryPerpFill = fills.find((f) => f.leg === "perp" && f.side === "Sell");
  const entrySpotFill = fills.find((f) => f.leg === "spot" && f.side === "Buy");
  const exitPerpFill = fills.find((f) => f.leg === "perp" && f.side === "Buy");
  const exitSpotFill = fills.find((f) => f.leg === "spot" && f.side === "Sell");
  if (!entryPerpFill || !entrySpotFill || !exitPerpFill || !exitSpotFill) {
    throw new Error(
      `paper_positions.id=${position.id.toString()}: expected 4 fills (entry perp Sell + spot Buy, exit perp Buy + ` +
        `spot Sell), found ${String(fills.length)} — cannot reconstruct this trade's P&L breakdown.`,
    );
  }

  const spotQty = new Big(position.spot_qty);
  const perpQty = new Big(position.perp_qty);
  const entrySpotPrice = new Big(entrySpotFill.price);
  const entryPerpPrice = new Big(entryPerpFill.price);
  const exitSpotPrice = new Big(exitSpotFill.price);
  const exitPerpPrice = new Big(exitPerpFill.price);

  // Same normalization convention as realizedPnl.ts/equityEngine.ts: basis is
  // (perp - spot) / spot, and each leg notional uses the SAME price its own
  // basis is normalized by — exactly what scenarioRunner.ts's closePosition
  // computed at the instant it wrote these fills, recomputed here from the
  // persisted fill prices rather than re-reading any unpersisted field.
  const entryBasis = entryPerpPrice.minus(entrySpotPrice).div(entrySpotPrice);
  const exitBasis = exitPerpPrice.minus(exitSpotPrice).div(exitSpotPrice);
  const entryLegNotional = spotQty.times(entrySpotPrice);
  const exitLegNotional = spotQty.times(exitSpotPrice);

  const grossFundingCollected = bigSum(fundingPayments.map((f) => new Big(f.amount)));
  const totalFees = bigSum([entryPerpFill, entrySpotFill, exitPerpFill, exitSpotFill].map((f) => new Big(f.fee)));

  const breakdown = computeRealizedPnlBreakdown({
    entryLegNotional,
    exitLegNotional,
    entryBasis,
    exitBasis,
    grossFundingCollected,
    totalFees,
    realizedSlippage: new Big(position.slippage_cost),
  });

  // Not part of computeRealizedPnlBreakdown's own total (same as
  // scenarioRunner.ts's own closePosition, which subtracts it separately) —
  // stored as a positive cost magnitude, negated here into this file's cost
  // convention (<= 0, see module doc comment).
  const borrowCostUsd = new Big(position.borrow_cost).times(-1);
  const netPnlUsd = breakdown.total.plus(borrowCostUsd);

  const notional = perpQty.times(entryPerpPrice);
  const netPnlPctOfNotional = notional.eq(0) ? new Big(0) : netPnlUsd.div(notional).times(100);

  const holdDurationHours = new Big(position.closed_at.getTime() - position.opened_at.getTime()).div(MS_PER_HOUR);

  const result: TradeRow["result"] = netPnlUsd.gt(0) ? "win" : netPnlUsd.lt(0) ? "loss" : "breakeven";

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    tradeId: position.id,
    symbol: position.symbol,
    leverageTarget: new Big(position.leverage),
    entryAt: position.opened_at,
    exitAt: position.closed_at,
    holdDurationHours,
    fundingUsd: breakdown.fundingComponent,
    basisPnlUsd: breakdown.basisComponent,
    feesUsd: breakdown.feesComponent,
    slippageUsd: breakdown.slippageComponent,
    borrowCostUsd,
    netPnlUsd,
    netPnlPctOfNotional,
    result,
    entryContext: parseReasoningText(position.entry_reasoning),
    exitContext: parseReasoningText(position.exit_reasoning),
  };
}

export async function fetchEquitySnapshots(db: Kysely<Database>, scenarioId: bigint): Promise<EquitySnapshotPoint[]> {
  const rows = await db
    .selectFrom("paper_equity_snapshots")
    .select(["at", "total_equity"])
    .where("scenario_id", "=", scenarioId)
    .orderBy("at", "asc")
    // Tiebreaker for same-`at` rows: the "never leave a position open at
    // range end" force-close (scenarioRunner.ts) writes a second snapshot at
    // the same `at` as the main loop's last-tick snapshot when the winning
    // candidate opens on the scenario's final tick. `id` is insertion-order
    // (bigserial), and that force-close row is always inserted after the
    // main loop's, so ordering by it deterministically picks the true final
    // (post-close) equity over the stale still-open mark-to-market row.
    .orderBy("id", "asc")
    .execute();
  return rows.map((r) => ({ at: r.at, totalEquity: new Big(r.total_equity) }));
}

/**
 * Unlike fetchClosedTrades (CLOSED positions only — a "trade" implies a
 * finished round trip), the equity curve reflects ALL activity in the
 * scenario, including a position still open at report-generation time (only
 * reachable for a `status='failed'` scenario — runScenario's own "never
 * leave a position open at range end" logic guarantees a `completed` one has
 * none), so this reads every position/fill/funding-payment for the
 * scenario, not just the closed subset.
 */
export async function fetchScenarioActivity(db: Kysely<Database>, scenarioId: bigint): Promise<ScenarioActivity> {
  const positions = await db
    .selectFrom("paper_positions")
    .select(["opened_at", "closed_at"])
    .where("scenario_id", "=", scenarioId)
    .execute();

  const fills = await db
    .selectFrom("paper_fills")
    .innerJoin("paper_positions", "paper_positions.id", "paper_fills.position_id")
    .select(["paper_fills.fee as fee", "paper_fills.executed_at as executed_at"])
    .where("paper_positions.scenario_id", "=", scenarioId)
    .execute();

  const fundingPayments = await db
    .selectFrom("paper_funding_payments")
    .innerJoin("paper_positions", "paper_positions.id", "paper_funding_payments.position_id")
    .select(["paper_funding_payments.amount as amount", "paper_funding_payments.paid_at as paid_at"])
    .where("paper_positions.scenario_id", "=", scenarioId)
    .execute();

  return { positions, fills, fundingPayments };
}
