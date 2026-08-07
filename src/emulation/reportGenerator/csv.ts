import Big from "big.js";
import { bigSum, MS_PER_HOUR, utcDate, type EquitySnapshotPoint, type ScenarioActivity, type ScenarioRow, type ScenarioSummary } from "./shared.js";
import { buildNarrative } from "./narrative.js";

// CSV-writing sub-file of ../reportGenerator.ts — see that file's module doc
// comment for the full picture (sign convention, the equity-curve CSV's
// known daily_borrow_cost_usd gap). Covers both `paper_trades_<run_id>.csv`
// and `paper_equity_curve_<run_id>.csv`.

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

export function buildTradesCsv(summaries: ScenarioSummary[]): string {
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

export function buildEquityCurveCsv(
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
