import Big from "big.js";
import {
  bigSum,
  ENTRY_GROSS_MULTIPLIER,
  MIN_ENTRY_MARGIN_PASS_RATE,
  NO_R8H_DATA_BUCKET_LABEL,
  R8H_BUCKETS,
  REALITY_ADJUST_HIGH,
  REALITY_ADJUST_LOW,
  parseContextBig,
  utcDate,
  type EquitySnapshotPoint,
  type ScenarioSummary,
  type TradeRow,
} from "./shared.js";

// Summary-markdown sub-file of ../reportGenerator.ts — see that file's module
// doc comment for the full picture (sign convention, the "entry passed with
// real margin" verdict, start_date/end_date semantics).

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
export function computeMaxDrawdownPct(startingDeposit: Big, snapshotsAsc: EquitySnapshotPoint[]): Big {
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

export function buildSummaryMarkdown(runId: string, summaries: ScenarioSummary[]): string {
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
