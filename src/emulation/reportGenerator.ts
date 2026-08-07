import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import { fetchClosedTrades, fetchEquitySnapshots, fetchScenarioActivity, fetchScenarios } from "./reportGenerator/dataAccess.js";
import { buildSummaryMarkdown } from "./reportGenerator/summary.js";
import { buildEquityCurveCsv, buildTradesCsv } from "./reportGenerator/csv.js";
import type {
  EquitySnapshotPoint,
  GenerateReportsResult,
  ScenarioActivity,
  ScenarioRow,
  ScenarioSummary,
} from "./reportGenerator/shared.js";

export { csvEscapeField } from "./reportGenerator/csv.js";
export type { GenerateReportsResult } from "./reportGenerator/shared.js";

/**
 * Backlog (Фаза 2 эмуляция): turns the rows one or more `scenarioRunner.ts`
 * runs already journaled into `paper_scenarios`/`paper_positions`/
 * `paper_fills`/`paper_funding_payments`/`paper_equity_snapshots` into the
 * three human/programmatic report artifacts the owner asked for — see the
 * design spec this file implements (decided earlier in-session, not
 * re-derived here):
 *   1. `paper_summary_<run_id>.md`  — one markdown table, one row per scenario.
 *   2. `paper_trades_<run_id>.csv`  — one row per CLOSED paper_positions row.
 *   3. `paper_equity_curve_<run_id>.csv` — one row per scenario per calendar day.
 *
 * `generateReports` is DB-reads-only (no writes to any table, no filesystem
 * writes, no network calls) and returns the three bodies as strings —
 * writing them to disk under their `<run_id>`-suffixed filenames, and/or
 * handing them to `notify/telegram.ts`'s `sendDocument`, is the CALLER's job.
 *
 * There is no `run_id` column anywhere in this schema (paper_scenarios has
 * no such field) — a "run" only exists as the caller's own bookkeeping. The
 * `scenarioIds` argument IS the run: every scenario the caller considers
 * part of this run, in the order they want it reported (this order becomes
 * `scenario_order`, 1-based). `runId` is used only as a label inside the
 * generated markdown's title — filenames are the caller's responsibility.
 *
 * ============================================================================
 * SIGN CONVENTION — same as execution/realizedPnl.ts's RealizedPnlBreakdown
 * ============================================================================
 * `funding_*_usd`/`basis_pnl_usd` are signed P&L components (can be negative).
 * `fees_usd`/`slippage_usd`/`borrow_cost_usd`/`daily_fees_usd`/
 * `daily_borrow_cost_usd` are reported as costs, i.e. <= 0, mirroring
 * `RealizedPnlBreakdown.feesComponent`/`.slippageComponent`'s own documented
 * sign ("negative (a cost)") rather than inventing a separate positive-
 * magnitude convention — so `net_pnl_usd` is always simply the SUM of every
 * component column on that same row, no sign-flipping required by a reader.
 *
 * ============================================================================
 * slippage_usd / borrow_cost_usd (per-trade) — sourced from paper_positions
 * ============================================================================
 * `scenarioRunner.ts` computes a real per-trade slippage dollar cost
 * (`entrySpotSlippageBp`/`entryPerpSlippageBp`, applied in its own
 * `closePosition`) and a real per-position borrow-interest accrual
 * (`OpenPositionState.borrowCostAccrued`, accumulated in `accrueBorrowCost`)
 * and folds BOTH into the cash it actually returns to the scenario's idle-
 * cash pool. Both are ALSO persisted, at close time, as
 * `paper_positions.slippage_cost`/`.borrow_cost` (positive cost magnitudes,
 * same sign convention as `paper_fills.fee`) — this file reads those two
 * columns back directly rather than reconstructing them, since (unlike
 * basis/funding/fees) they cannot be rederived from `paper_fills`/
 * `paper_funding_payments` alone: `paper_fills.price` is the ticker mark
 * price itself (scenarioRunner's own doc comment: "not a book-walked
 * average"), so it carries no residual trace of slippage, and there is no
 * per-tick borrow-accrual table, only the final accrued total at close.
 *
 * KNOWN GAP that remains: the equity-curve CSV's `daily_borrow_cost_usd` is
 * still hardcoded `"0"` — `paper_positions.borrow_cost` is one lump sum for
 * the whole hold, not broken down per calendar day the way
 * `paper_funding_payments`/`paper_fills` naturally are, so a position held
 * across multiple days has no persisted way to attribute its borrow cost to
 * any one of them. Fixing that would need per-tick or per-day accrual
 * persistence in `scenarioRunner.ts` (out of this file's zone).
 *
 * ============================================================================
 * "Entry passed with real margin" (summary verdict) — RR-24/FM-01, realized
 * ============================================================================
 * `risk/economics.ts`'s `checkEntryThreshold` gates a candidate at DECISION
 * time on `expectedGross (r8h × expectedHoldIntervals) >= K × totalRoundTripCost`,
 * with `K = ENTRY_GROSS_MULTIPLIER = 2.0` (RR-24/FM-01) — that constant is not
 * exported from risk/economics.ts, so the identical literal `2.0` is
 * duplicated here on purpose (see `ENTRY_GROSS_MULTIPLIER` below), not
 * approximated to some other "roughly 2x" figure.
 *
 * This file runs a REALIZED analogue of that same K=2.0 gate, per closed
 * trade, using fees as the cost side: a trade "passed with real margin" iff
 * `fundingUsd >= K × |feesUsd|`. `slippage_usd`/`borrow_cost_usd` are now
 * also available per trade (see above) but are deliberately NOT folded into
 * this check — it stays fees-only, unchanged by that addition; broadening it
 * to mirror `totalRoundTripCost`'s fees+slippage definition exactly is a
 * separate decision, not made here. A scenario's verdict requires >= 80% of
 * its closed trades to clear that bar.
 *
 * ============================================================================
 * start_date / end_date (summary) — NOT paper_scenarios.started_at/stopped_at
 * ============================================================================
 * `paper_scenarios.started_at`/`.stopped_at` are the wall-clock instants the
 * `runScenario` CALL itself began/finished — not the historical market-data
 * window it replayed (`ScenarioConfig.startAt`/`.endAt`, never persisted
 * anywhere in this schema). The min/max `paper_equity_snapshots.at` for the
 * scenario IS that historical window (a snapshot is written for every tick
 * from `config.startAt` to `config.endAt` inclusive — see scenarioRunner.ts's
 * main loop), so that is what `start_date`/`end_date` report here.
 *
 * ============================================================================
 * File layout (post-split)
 * ============================================================================
 * This file is now a thin barrel — the implementation lives in
 * ./reportGenerator/:
 *   - shared.ts     — constants, row/type shapes, small pure helpers.
 *   - dataAccess.ts — DB reads + per-trade P&L reconstruction (buildTradeRow).
 *   - summary.ts    — the summary markdown (incl. "Закономерности" section).
 *   - narrative.ts  — the trades CSV's per-trade `narrative` column text.
 *   - csv.ts        — CSV formatting + the trades/equity-curve CSV builders.
 * This file itself keeps only the `generateReports` orchestrator and the
 * re-exports of `csvEscapeField`/`GenerateReportsResult` for callers.
 */

/**
 * Reads back everything one or more scenarioRunner.ts runs (`scenarioIds`)
 * journaled, and renders the three paper-trading report artifacts described
 * in this module's own doc comment. Pure DB-reads-only: does not write to
 * any table, does not touch the filesystem, does not call Telegram — see
 * module doc comment.
 */
export async function generateReports(
  db: Kysely<Database>,
  runId: string,
  scenarioIds: bigint[],
): Promise<GenerateReportsResult> {
  if (scenarioIds.length === 0) {
    throw new RangeError("generateReports: scenarioIds must be non-empty");
  }

  const scenarios = await fetchScenarios(db, scenarioIds);

  const summaries: ScenarioSummary[] = [];
  const equityInputs: { scenario: ScenarioRow; snapshots: EquitySnapshotPoint[]; activity: ScenarioActivity }[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]!;
    const [trades, snapshots, activity] = await Promise.all([
      fetchClosedTrades(db, scenario),
      fetchEquitySnapshots(db, scenario.id),
      fetchScenarioActivity(db, scenario.id),
    ]);
    summaries.push({ order: i + 1, scenario, trades, snapshots });
    equityInputs.push({ scenario, snapshots, activity });
  }

  return {
    summaryMarkdown: buildSummaryMarkdown(runId, summaries),
    tradesCsv: buildTradesCsv(summaries),
    equityCurveCsv: buildEquityCurveCsv(equityInputs),
  };
}
