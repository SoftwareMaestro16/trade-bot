import Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import { computeRealizedPnlBreakdown } from "../execution/realizedPnl.js";

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
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** risk/economics.ts's ENTRY_GROSS_MULTIPLIER (K=2.0, RR-24/FM-01) — see module doc comment. */
const ENTRY_GROSS_MULTIPLIER = new Big("2.0");

/** Design spec: >= 80% of a scenario's closed trades must have passed the realized entry-margin check. */
const MIN_ENTRY_MARGIN_PASS_RATE = new Big("0.80");

/** Design spec: reality-adjusted P&L band applied to NET p&l — brief's own "live will be 30-50% worse than paper" caveat. */
const REALITY_ADJUST_LOW = new Big("0.5");
const REALITY_ADJUST_HIGH = new Big("0.7");

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * risk/economics.ts's ENTRY_FLOOR_R8H (0.020%/8h — "never 0.010%",
 * PARAMS-CONSERVATIVE.md §5, checkEntryThreshold's floor gate) — not exported
 * from that module, so duplicated here on purpose, same convention as
 * ENTRY_GROSS_MULTIPLIER above. Used only for the narrative CSV column's "N×
 * above the entry floor" framing and the summary's r8h buckets below — never
 * re-derives or re-checks an actual entry decision.
 */
const ENTRY_FLOOR_R8H = new Big("0.0002");

/** strategy/exitRules.ts / scenarioRunner.ts's closePosition reasonCode values, translated for the narrative column and the "Закономерности" section. An unrecognized code (future exitRules.ts addition) falls back to the raw code untranslated — see buildNarrative/exitReasonForTrade. */
// "по причине" governs the genitive case (like "из-за") — every phrase below
// must be genitive, not dative. FORCED_LIQUIDATION's "ликвидации" is correct
// either way (soft feminine -ия nouns share one form across genitive/dative/
// prepositional singular), which is what let the other five slip through.
const EXIT_REASON_RU: Record<string, string> = {
  FUNDING_TURNED_NEGATIVE: "разворота funding rate в отрицательную зону",
  APR_HYSTERESIS_TRIGGERED: "падения текущего APR ниже порога гистерезиса от APR входа",
  BASIS_DIVERGED: "экстренного расхождения базиса сверх аварийного порога",
  DELISTED_OR_CONTRACT_CHANGED: "делистинга или смены параметров контракта",
  FORCED_LIQUIDATION: "принудительной ликвидации перп-ноги",
  SCENARIO_END: "окончания периода сценария (позиция оставалась открытой)",
};

/** Fixed r8h buckets for the "Закономерности" win-rate-by-entry-funding table — boundaries per owner's own spec, the lower one reusing ENTRY_FLOOR_R8H above. */
const R8H_BUCKETS: { label: string; min: Big; max: Big | undefined }[] = [
  { label: "0.02–0.05%/8ч", min: ENTRY_FLOOR_R8H, max: new Big("0.0005") },
  { label: "0.05–0.15%/8ч", min: new Big("0.0005"), max: new Big("0.0015") },
  { label: "выше 0.15%/8ч", min: new Big("0.0015"), max: undefined },
];

/** A trade whose entry_reasoning has no parseable `r8h=` field (e.g. pre-this-feature data) — grouped separately rather than silently dropped or mis-bucketed. */
const NO_R8H_DATA_BUCKET_LABEL = "нет данных о funding при входе";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateReportsResult {
  summaryMarkdown: string;
  tradesCsv: string;
  equityCurveCsv: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface ScenarioRow {
  id: bigint;
  name: string;
  leverage: string;
  starting_deposit: string;
  status: string;
}

interface TradeRow {
  scenarioId: bigint;
  scenarioName: string;
  tradeId: bigint;
  symbol: string;
  leverageTarget: Big;
  entryAt: Date;
  exitAt: Date;
  holdDurationHours: Big;
  fundingUsd: Big;
  basisPnlUsd: Big;
  feesUsd: Big; // <= 0
  slippageUsd: Big; // <= 0, from paper_positions.slippage_cost
  borrowCostUsd: Big; // <= 0, from paper_positions.borrow_cost
  netPnlUsd: Big;
  netPnlPctOfNotional: Big;
  result: "win" | "loss" | "breakeven";
  /** paper_positions.entry_reasoning, parsed as `key=value` pairs — see parseReasoningText. Empty object if null/unparseable (e.g. pre-this-feature fixture text). */
  entryContext: Record<string, string>;
  /** paper_positions.exit_reasoning, parsed the same way — `detail` (if present) is always the LAST key, its value the free-text remainder of the string. */
  exitContext: Record<string, string>;
}

interface EquitySnapshotPoint {
  at: Date;
  totalEquity: Big;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function groupBy<T>(items: T[], keyOf: (t: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function bigSum(values: Big[]): Big {
  return values.reduce((acc, v) => acc.plus(v), new Big(0));
}

/**
 * Parses scenarioRunner.ts's `entry_reasoning`/`exit_reasoning` free-text
 * format (`key1=value1 key2=value2 ... detail=free text sentence`, see that
 * file's openNewPosition/closePosition) into a plain lookup. Every key except
 * `detail` has a single non-space token as its value (a Big decimal string,
 * "n/a", or a bare code) so a greedy `key=token` scan is enough; `detail`,
 * when present, is always the LAST key and its value runs to the end of the
 * string (a full human sentence, which may itself contain spaces) — handled
 * as a special case rather than by the same per-token regex.
 *
 * Returns `{}` for null/empty text, or for text with no `key=value` pairs at
 * all (e.g. older fixtures/rows that predate this format) — callers must
 * treat every field as optional, never assume a key is present.
 */
function parseReasoningText(text: string | null): Record<string, string> {
  if (!text) return {};
  const detailMarker = "detail=";
  const detailIdx = text.indexOf(detailMarker);
  const head = detailIdx === -1 ? text : text.slice(0, detailIdx);
  const fields: Record<string, string> = {};
  for (const match of head.matchAll(/(\S+?)=(\S*)/g)) {
    fields[match[1]!] = match[2]!;
  }
  if (detailIdx !== -1) {
    fields.detail = text.slice(detailIdx + detailMarker.length);
  }
  return fields;
}

/**
 * Reads a parsed entry_reasoning/exit_reasoning field as a Big, or undefined
 * if absent/"n/a"/unparseable. Shared by buildNarrative (per-trade CSV
 * column) and the "Закономерности" aggregation below — never throws, since
 * both callers treat a missing/malformed field as "no data", not an error.
 */
function parseContextBig(context: Record<string, string>, key: string): Big | undefined {
  const raw = context[key];
  if (raw === undefined || raw === "n/a") return undefined;
  try {
    return new Big(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

async function fetchScenarios(db: Kysely<Database>, scenarioIds: bigint[]): Promise<ScenarioRow[]> {
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

async function fetchClosedTrades(db: Kysely<Database>, scenario: ScenarioRow): Promise<TradeRow[]> {
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

async function fetchEquitySnapshots(db: Kysely<Database>, scenarioId: bigint): Promise<EquitySnapshotPoint[]> {
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

interface ScenarioActivity {
  positions: { opened_at: Date | null; closed_at: Date | null }[];
  fills: { fee: string; executed_at: Date }[];
  fundingPayments: { amount: string; paid_at: Date }[];
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
async function fetchScenarioActivity(db: Kysely<Database>, scenarioId: bigint): Promise<ScenarioActivity> {
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

// ---------------------------------------------------------------------------
// Summary markdown
// ---------------------------------------------------------------------------

/**
 * Peak starts at `startingDeposit` — the same seed scenarioRunner.ts's own
 * `executeScenario` uses for its `peakEquity` local (`let peakEquity =
 * config.startingDeposit`) — not at the first snapshot's own value. Seeding
 * from the first snapshot instead would make that very first snapshot
 * definitionally "the peak so far" no matter what it is, silently hiding a
 * drawdown that happened between the scenario's real starting capital and
 * its first recorded mark (and, for the equity-curve CSV's `is_new_peak`,
 * would make day one structurally unable to ever be flagged as a new peak).
 */
function computeMaxDrawdownPct(startingDeposit: Big, snapshotsAsc: EquitySnapshotPoint[]): Big {
  let peak = startingDeposit;
  let maxDrawdown = new Big(0);
  for (const point of snapshotsAsc) {
    if (point.totalEquity.gt(peak)) peak = point.totalEquity;
    if (peak.gt(0)) {
      const drawdown = peak.minus(point.totalEquity).div(peak).times(100);
      if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown;
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

interface ScenarioVerdict {
  netPnlUsd: Big;
  realityAdjustedLow: Big;
  realityAdjustedHigh: Big;
  verdict: string;
}

function computeVerdict(trades: TradeRow[], netPnlUsd: Big): ScenarioVerdict {
  // REALITY_ADJUST_LOW/HIGH encode "live is 30-50% worse than paper". For a paper GAIN,
  // "worse" means the gain shrinks, so multiplying directly by 0.5/0.7 is correct. For a
  // paper LOSS, "worse" means the loss deepens — multiplying by 0.5/0.7 would instead
  // shrink the loss toward zero (backwards). Mirror the multiplier through 1 (i.e. use
  // 2 - REALITY_ADJUST_X, which equals 1 + the same 30-50% degradation) so a loss grows
  // by the same magnitude a gain would shrink by. "low" stays the more pessimistic
  // (lower) figure and "high" the less pessimistic one in both cases.
  const realityAdjustedLow = netPnlUsd.gte(0)
    ? netPnlUsd.times(REALITY_ADJUST_LOW)
    : netPnlUsd.times(new Big(2).minus(REALITY_ADJUST_LOW));
  const realityAdjustedHigh = netPnlUsd.gte(0)
    ? netPnlUsd.times(REALITY_ADJUST_HIGH)
    : netPnlUsd.times(new Big(2).minus(REALITY_ADJUST_HIGH));

  const passedCount = trades.filter((t) => t.fundingUsd.gte(ENTRY_GROSS_MULTIPLIER.times(t.feesUsd.times(-1)))).length;
  const tradeCount = trades.length;
  const passRate = tradeCount === 0 ? new Big(0) : new Big(passedCount).div(tradeCount);

  const reasons: string[] = [];
  if (!netPnlUsd.gt(0)) {
    reasons.push(`net_pnl_usd = ${netPnlUsd.toString()} (должно быть > 0)`);
  }
  if (!realityAdjustedLow.gt(0)) {
    reasons.push(`reality_adjusted_pnl_low_usd = ${realityAdjustedLow.toString()} (должно быть > 0)`);
  }
  if (tradeCount === 0) {
    reasons.push("нет закрытых сделок — процент прохождения порога входа не определён");
  } else if (passRate.lt(MIN_ENTRY_MARGIN_PASS_RATE)) {
    reasons.push(
      `только ${String(passedCount)}/${String(tradeCount)} сделок (${passRate.times(100).toString()}%) прошли порог ` +
        `входа "funding >= ${ENTRY_GROSS_MULTIPLIER.toString()}x fees" (RR-24/FM-01, risk/economics.ts checkEntryThreshold); нужно >= 80%`,
    );
  }

  const verdict = reasons.length === 0 ? "экономика входа подтверждена" : `не подтверждена: ${reasons.join("; ")}`;
  return { netPnlUsd, realityAdjustedLow, realityAdjustedHigh, verdict };
}

interface ScenarioSummary {
  order: number;
  scenario: ScenarioRow;
  trades: TradeRow[];
  snapshots: EquitySnapshotPoint[];
}

// ---------------------------------------------------------------------------
// "Закономерности" — aggregated cross-scenario patterns (summary markdown)
// ---------------------------------------------------------------------------
//
// Pure aggregation over the SAME TradeRow[] already read for the trades CSV
// (see generateReports' orchestrator — no separate DB query issued here).

/** Which fixed r8h_BUCKETS label a trade's parsed entry r8h falls into, or NO_R8H_DATA_BUCKET_LABEL if entry_reasoning had no parseable `r8h=` field. A value below the lowest bucket's floor (not expected given the live entry gate, but this reads historical text, not a re-validated number) is grouped with that lowest bucket rather than invented a new one. */
function bucketForEntryR8h(trade: TradeRow): string {
  const r8h = parseContextBig(trade.entryContext, "r8h");
  if (r8h === undefined) return NO_R8H_DATA_BUCKET_LABEL;
  for (const bucket of R8H_BUCKETS) {
    if (r8h.gte(bucket.min) && (bucket.max === undefined || r8h.lt(bucket.max))) return bucket.label;
  }
  return R8H_BUCKETS[0]!.label;
}

const NO_EXIT_REASON_DATA_LABEL = "нет данных о причине выхода";

/** The raw reasonCode from exit_reasoning (BASIS_DIVERGED, FORCED_LIQUIDATION, ...) — NOT translated here, unlike buildNarrative's prose, so the table groups/sorts on the stable machine code. */
function exitReasonForTrade(trade: TradeRow): string {
  return trade.exitContext.reasonCode ?? NO_EXIT_REASON_DATA_LABEL;
}

/** "N/A" (not "0" or a division-by-zero NaN) when there are no trades to rate. */
function formatWinRatePct(wins: number, total: number): string {
  return total === 0 ? "N/A" : new Big(wins).div(total).times(100).toFixed(1);
}

/** "N/A" when the group is empty — same reasoning as formatWinRatePct. */
function formatAvgHours(trades: TradeRow[]): string {
  if (trades.length === 0) return "N/A";
  return bigSum(trades.map((t) => t.holdDurationHours)).div(trades.length).toFixed(2);
}

/**
 * Design spec (owner's ask): (a) win rate by entry-r8h bucket, (b) average
 * hold duration for winning vs. losing trades, (c) exit-reason distribution
 * with a win rate per reason. Pure aggregation over `allTrades` — the same
 * TradeRow[] already assembled for the trades CSV, no new DB read.
 */
function buildPatternsSection(allTrades: TradeRow[]): string[] {
  const lines: string[] = ["", "## Закономерности"];

  if (allTrades.length === 0) {
    lines.push(
      "",
      "_Нет закрытых сделок ни в одном сценарии этого прогона — агрегированные закономерности недоступны._",
    );
    return lines;
  }

  // (a) win rate by entry r8h bucket
  lines.push("", "### Win rate по диапазону funding при входе (r8h)", "");
  lines.push("| Диапазон r8h | Сделок | Побед | Win rate, % |");
  lines.push("| --- | --- | --- | --- |");
  for (const label of [...R8H_BUCKETS.map((b) => b.label), NO_R8H_DATA_BUCKET_LABEL]) {
    const trades = allTrades.filter((t) => bucketForEntryR8h(t) === label);
    const wins = trades.filter((t) => t.result === "win").length;
    lines.push(
      `| ${mdEscape(label)} | ${String(trades.length)} | ${String(wins)} | ${formatWinRatePct(wins, trades.length)} |`,
    );
  }

  // (b) average hold duration, winning vs. losing trades
  lines.push("", "### Средняя длительность удержания: прибыльные vs убыточные", "");
  lines.push("| Результат | Сделок | Средняя длительность, ч |");
  lines.push("| --- | --- | --- |");
  for (const result of ["win", "loss", "breakeven"] as const) {
    const trades = allTrades.filter((t) => t.result === result);
    lines.push(`| ${result} | ${String(trades.length)} | ${formatAvgHours(trades)} |`);
  }

  // (c) exit-reason distribution + win rate per reason
  lines.push("", "### Распределение причин выхода", "");
  lines.push("| Причина выхода | Сделок | Побед | Win rate, % |");
  lines.push("| --- | --- | --- | --- |");
  const reasons = [...new Set(allTrades.map((t) => exitReasonForTrade(t)))].sort();
  for (const reason of reasons) {
    const trades = allTrades.filter((t) => exitReasonForTrade(t) === reason);
    const wins = trades.filter((t) => t.result === "win").length;
    lines.push(
      `| ${mdEscape(reason)} | ${String(trades.length)} | ${String(wins)} | ${formatWinRatePct(wins, trades.length)} |`,
    );
  }

  return lines;
}

function buildSummaryMarkdown(runId: string, summaries: ScenarioSummary[]): string {
  const header = [
    "scenario_order",
    "scenario_name",
    "leverage_target",
    "start_date",
    "end_date",
    "starting_deposit_usd",
    "ending_equity_usd",
    "total_return_pct",
    "funding_income_usd",
    "basis_pnl_usd",
    "fees_usd",
    "slippage_usd",
    "borrow_cost_usd",
    "net_pnl_usd",
    "trade_count",
    "win_rate_pct",
    "max_drawdown_pct",
    "reality_adjusted_pnl_low_usd",
    "reality_adjusted_pnl_high_usd",
    "verdict",
  ];

  const rows = summaries.map(({ order, scenario, trades, snapshots }) => {
    const startingDeposit = new Big(scenario.starting_deposit);
    const lastSnapshot = snapshots[snapshots.length - 1];
    const endingEquity = lastSnapshot ? lastSnapshot.totalEquity : startingDeposit;
    const totalReturnPct = startingDeposit.eq(0)
      ? new Big(0)
      : endingEquity.minus(startingDeposit).div(startingDeposit).times(100);

    const fundingIncome = bigSum(trades.map((t) => t.fundingUsd));
    const basisPnl = bigSum(trades.map((t) => t.basisPnlUsd));
    const fees = bigSum(trades.map((t) => t.feesUsd));
    const slippage = bigSum(trades.map((t) => t.slippageUsd));
    const borrowCost = bigSum(trades.map((t) => t.borrowCostUsd));
    const netPnlUsd = fundingIncome.plus(basisPnl).plus(fees).plus(slippage).plus(borrowCost);

    const winCount = trades.filter((t) => t.netPnlUsd.gt(0)).length;
    const winRatePct = trades.length === 0 ? new Big(0) : new Big(winCount).div(trades.length).times(100);

    const maxDrawdownPct = computeMaxDrawdownPct(startingDeposit, snapshots);

    const firstSnapshot = snapshots[0];
    const startDate = firstSnapshot ? utcDate(firstSnapshot.at) : "N/A";
    const endDate = lastSnapshot ? utcDate(lastSnapshot.at) : "N/A";

    const { realityAdjustedLow, realityAdjustedHigh, verdict } = computeVerdict(trades, netPnlUsd);

    return [
      String(order),
      mdEscape(scenario.name),
      new Big(scenario.leverage).toString(),
      startDate,
      endDate,
      startingDeposit.toString(),
      endingEquity.toString(),
      totalReturnPct.toString(),
      fundingIncome.toString(),
      basisPnl.toString(),
      fees.toString(),
      slippage.toString(),
      borrowCost.toString(),
      netPnlUsd.toString(),
      String(trades.length),
      winRatePct.toString(),
      maxDrawdownPct.toString(),
      realityAdjustedLow.toString(),
      realityAdjustedHigh.toString(),
      mdEscape(verdict),
    ];
  });

  const allTrades = summaries.flatMap((s) => s.trades);

  const lines = [
    `# Paper-trading report — run ${runId}`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "_fees_usd / slippage_usd / borrow_cost_usd are costs, reported <= 0 (same convention as " +
      "execution/realizedPnl.ts's RealizedPnlBreakdown) — net_pnl_usd is the plain sum of every component " +
      "column on the row._",
    ...buildPatternsSection(allTrades),
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Narrative (human-readable causality) — trades.csv's `narrative` column
// ---------------------------------------------------------------------------
//
// Built ONLY from (a) paper_positions.entry_reasoning/exit_reasoning, parsed
// via parseReasoningText, and (b) this file's own already-computed TradeRow
// P&L components — never a fabricated figure. Any field missing from the
// parsed context (older data, a field that legitimately wasn't collected yet
// at that instant — see scenarioRunner.ts's openInterest/longShortRatio doc
// comments) simply drops that clause from the sentence rather than guessing.

/** `0.0015` -> "0.150%" (fraction -> percent string, fixed decimals). */
function pctStr(fraction: Big, decimals: number): string {
  return `${fraction.times(100).toFixed(decimals)}%`;
}

/** `-0.9` -> "-$0.90", `4.1` -> "+$4.10" — sign always explicit, so a reader never has to infer cost vs. income from context. */
function usdStr(amount: Big): string {
  const sign = amount.gte(0) ? "+" : "-";
  return `${sign}$${amount.abs().toFixed(2)}`;
}

/** Russian noun pluralization (1 -> one, 2-4 -> few, 5-20/0/5-9 -> many), standard genitive-count rule including the 11-14 exception. */
function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * One connected Russian sentence per closed trade, assembled from
 * entry_reasoning (funding rate + long/short skew at entry),
 * exit_reasoning (hold duration's funding-payment count, exit reason code),
 * and this row's own already-computed P&L components (funding/basis/costs/
 * net). Designed for `paper_trades_<run_id>.csv`'s `narrative` column — see
 * module doc comment.
 */
function buildNarrative(trade: TradeRow): string {
  const sentences: string[] = [];

  // --- Entry: funding rate (vs. the entry floor) + long/short skew ---
  const entryParts: string[] = [];
  const entryR8h = parseContextBig(trade.entryContext, "r8h");
  if (entryR8h !== undefined) {
    let clause = `Вход при funding ${pctStr(entryR8h, 3)}/8ч`;
    if (entryR8h.gt(0)) {
      const multiple = entryR8h.div(ENTRY_FLOOR_R8H);
      clause += ` (в ${multiple.toFixed(1)}× выше порога входа ${pctStr(ENTRY_FLOOR_R8H, 3)})`;
    }
    entryParts.push(clause);
  }
  const buyRatio = parseContextBig(trade.entryContext, "lsrBuyRatio");
  const sellRatio = parseContextBig(trade.entryContext, "lsrSellRatio");
  if (buyRatio !== undefined && sellRatio !== undefined) {
    if (buyRatio.gt(sellRatio) && sellRatio.gt(0)) {
      entryParts.push(`long/short ratio ${buyRatio.div(sellRatio).toFixed(2)} — перекос в лонги`);
    } else if (sellRatio.gt(buyRatio) && buyRatio.gt(0)) {
      entryParts.push(`long/short ratio ${sellRatio.div(buyRatio).toFixed(2)} — перекос в шорты`);
    } else if (buyRatio.eq(sellRatio)) {
      entryParts.push("long/short ratio без выраженного перекоса");
    } else if (buyRatio.gt(sellRatio)) {
      entryParts.push("long/short ratio: 100% лонги (шортов нет) — предельный перекос в лонги");
    } else if (sellRatio.gt(buyRatio)) {
      entryParts.push("long/short ratio: 100% шорты (лонгов нет) — предельный перекос в шорты");
    }
  }
  if (entryParts.length > 0) sentences.push(entryParts.join(", ") + ".");

  // --- Hold duration (TradeRow's own precise figure, not exit_reasoning's rounded text copy) + funding payment count ---
  const holdClause = `Удержана ${trade.holdDurationHours.toFixed(2)}ч`;
  const fundingPaymentsRaw = trade.exitContext.fundingPaymentsCollected;
  const fundingPaymentsCount = fundingPaymentsRaw !== undefined ? Number.parseInt(fundingPaymentsRaw, 10) : undefined;
  if (fundingPaymentsCount !== undefined && Number.isFinite(fundingPaymentsCount)) {
    const noun = ruPlural(fundingPaymentsCount, "выплата", "выплаты", "выплат");
    sentences.push(`${holdClause}, получено ${String(fundingPaymentsCount)} ${noun} funding.`);
  } else {
    sentences.push(`${holdClause}.`);
  }

  // --- Exit reason ---
  const reasonCode = trade.exitContext.reasonCode;
  if (reasonCode !== undefined) {
    const ruReason = EXIT_REASON_RU[reasonCode] ?? reasonCode;
    const liquidationPrice = parseContextBig(trade.exitContext, "liquidationPrice");
    const priceClause = liquidationPrice !== undefined ? ` (цена ликвидации $${liquidationPrice.toFixed(2)})` : "";
    sentences.push(`Закрыта по причине: ${ruReason}${priceClause}.`);
  }

  // --- P&L breakdown, reusing this row's own already-computed components ---
  const costs = trade.feesUsd.plus(trade.slippageUsd).plus(trade.borrowCostUsd);
  const pnlParts = [`funding ${usdStr(trade.fundingUsd)}`];
  if (!trade.basisPnlUsd.eq(0)) pnlParts.push(`базис ${usdStr(trade.basisPnlUsd)}`);
  pnlParts.push(`издержки ${usdStr(costs)}`);
  sentences.push(`Итог: ${usdStr(trade.netPnlUsd)} (${pnlParts.join(", ")}).`);

  return sentences.join(" ");
}

// ---------------------------------------------------------------------------
// Trades CSV
// ---------------------------------------------------------------------------

/** RFC-4180 field escaping (quote/comma/CR/LF), shared with `exportPredictiveTrainingDataset.ts`. */
export function csvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvEscapeField).join(",");
}

function buildCsv(header: string[], rows: string[][]): string {
  const lines = [csvRow(header), ...rows.map((r) => csvRow(r))];
  // UTF-8 BOM (U+FEFF, written as an explicit escape rather than a literal
  // invisible character in source — a literal BOM here reads as suspicious
  // "irregular whitespace" to editors/linters/diffs) so a Cyrillic
  // scenario_name opened in Excel decodes correctly instead of being
  // mis-read as the system codepage. RFC 4180 record separator (CRLF),
  // trailing CRLF after the last row.
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function buildTradesCsv(summaries: ScenarioSummary[]): string {
  const header = [
    "scenario_id",
    "scenario_name",
    "trade_id",
    "symbol",
    "leverage_target",
    "entry_at",
    "exit_at",
    "hold_duration_hours",
    "funding_usd",
    "basis_pnl_usd",
    "fees_usd",
    "slippage_usd",
    "borrow_cost_usd",
    "net_pnl_usd",
    "net_pnl_pct_of_notional",
    "result",
    "narrative",
  ];

  const rows = summaries.flatMap(({ trades }) =>
    trades.map((t) => [
      t.scenarioId.toString(),
      t.scenarioName,
      t.tradeId.toString(),
      t.symbol,
      t.leverageTarget.toString(),
      t.entryAt.toISOString(),
      t.exitAt.toISOString(),
      t.holdDurationHours.toString(),
      t.fundingUsd.toString(),
      t.basisPnlUsd.toString(),
      t.feesUsd.toString(),
      t.slippageUsd.toString(),
      t.borrowCostUsd.toString(),
      t.netPnlUsd.toString(),
      t.netPnlPctOfNotional.toString(),
      t.result,
      buildNarrative(t),
    ]),
  );

  return buildCsv(header, rows);
}

// ---------------------------------------------------------------------------
// Equity curve CSV
// ---------------------------------------------------------------------------

interface DailyBucket {
  date: string;
  open: Big;
  close: Big;
  high: Big;
  low: Big;
}

function rollupDaily(snapshotsAsc: EquitySnapshotPoint[]): DailyBucket[] {
  const buckets = new Map<string, Big[]>();
  for (const point of snapshotsAsc) {
    const day = utcDate(point.at);
    const arr = buckets.get(day);
    if (arr) arr.push(point.totalEquity);
    else buckets.set(day, [point.totalEquity]);
  }
  return [...buckets.keys()].sort().map((date) => {
    const values = buckets.get(date)!;
    let high = values[0]!;
    let low = values[0]!;
    for (const v of values) {
      if (v.gt(high)) high = v;
      if (v.lt(low)) low = v;
    }
    return { date, open: values[0]!, close: values[values.length - 1]!, high, low };
  });
}

function isOpenDuringDay(
  position: { opened_at: Date | null; closed_at: Date | null },
  dayStartInclusive: Date,
  dayEndExclusive: Date,
): boolean {
  if (position.opened_at === null) return false;
  const openedMs = position.opened_at.getTime();
  const closedMs = position.closed_at === null ? Number.POSITIVE_INFINITY : position.closed_at.getTime();
  return openedMs < dayEndExclusive.getTime() && closedMs > dayStartInclusive.getTime();
}

function buildEquityCurveCsv(
  summaries: { scenario: ScenarioRow; snapshots: EquitySnapshotPoint[]; activity: ScenarioActivity }[],
): string {
  const header = [
    "scenario_id",
    "scenario_name",
    "date",
    "equity_open_usd",
    "equity_close_usd",
    "equity_high_usd",
    "equity_low_usd",
    "daily_pnl_usd",
    "daily_funding_usd",
    "daily_fees_usd",
    "daily_borrow_cost_usd",
    "open_positions_count",
    "cumulative_pnl_usd",
    "drawdown_from_peak_pct",
    "is_new_peak",
  ];

  const rows: string[][] = [];

  for (const { scenario, snapshots, activity } of summaries) {
    const daily = rollupDaily(snapshots);
    if (daily.length === 0) continue;

    const startingDeposit = new Big(scenario.starting_deposit);
    const fundingByDay = new Map<string, Big[]>();
    for (const f of activity.fundingPayments) {
      const day = utcDate(f.paid_at);
      const arr = fundingByDay.get(day);
      if (arr) arr.push(new Big(f.amount));
      else fundingByDay.set(day, [new Big(f.amount)]);
    }
    const feesByDay = new Map<string, Big[]>();
    for (const f of activity.fills) {
      const day = utcDate(f.executed_at);
      const arr = feesByDay.get(day);
      if (arr) arr.push(new Big(f.fee));
      else feesByDay.set(day, [new Big(f.fee)]);
    }

    // Seeded from startingDeposit, not daily[0]'s own high — see
    // computeMaxDrawdownPct's doc comment for why (same reasoning applies here).
    let runningPeak = startingDeposit;
    for (const bucket of daily) {
      const dayStart = new Date(`${bucket.date}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart.getTime() + 24 * MS_PER_HOUR);

      const dailyPnlUsd = bucket.close.minus(bucket.open);
      const dailyFundingUsd = bigSum(fundingByDay.get(bucket.date) ?? []);
      // Cost convention (<= 0), same as the summary/trades outputs — see module doc comment.
      const dailyFeesUsd = bigSum(feesByDay.get(bucket.date) ?? []).times(-1);
      // GAP: paper_positions.borrow_cost is one lump sum for the whole hold, not
      // attributable to any single calendar day — see module doc comment.
      const dailyBorrowCostUsd = new Big(0);

      const openPositionsCount = activity.positions.filter((p) => isOpenDuringDay(p, dayStart, dayEnd)).length;
      const cumulativePnlUsd = bucket.close.minus(startingDeposit);

      const peakBeforeToday = runningPeak;
      if (bucket.high.gt(runningPeak)) runningPeak = bucket.high;
      const isNewPeak = runningPeak.gt(peakBeforeToday);
      const drawdownFromPeakPct = runningPeak.gt(0)
        ? runningPeak.minus(bucket.close).div(runningPeak).times(100)
        : new Big(0);

      rows.push([
        scenario.id.toString(),
        scenario.name,
        bucket.date,
        bucket.open.toString(),
        bucket.close.toString(),
        bucket.high.toString(),
        bucket.low.toString(),
        dailyPnlUsd.toString(),
        dailyFundingUsd.toString(),
        dailyFeesUsd.toString(),
        dailyBorrowCostUsd.toString(),
        String(openPositionsCount),
        cumulativePnlUsd.toString(),
        drawdownFromPeakPct.toString(),
        String(isNewPeak),
      ]);
    }
  }

  return buildCsv(header, rows);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

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
