import Big from "big.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { generateReports } from "../../src/emulation/reportGenerator.js";
import { computeRealizedPnlBreakdown } from "../../src/execution/realizedPnl.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

/**
 * Real local/test Postgres required — same pattern as
 * test/market-data/collectionDigest.test.ts and
 * test/emulation/scenarioRunner.test.ts. No skip on a missing DATABASE_URL.
 *
 * Every fixture row here is inserted in EXACTLY the shape
 * src/emulation/scenarioRunner.ts itself writes (see its openNewPosition/
 * closePosition/writeEquitySnapshot/applySettledFundingUpTo): entry perp
 * fill side="Sell", entry spot fill side="Buy", exit perp fill side="Buy",
 * exit spot fill side="Sell", paper_positions.state="CLOSED" with both
 * opened_at/closed_at set, one paper_equity_snapshots row per mark.
 */

let db: Kysely<Database>;
const createdScenarioIds: bigint[] = [];

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  db = createDb(process.env.DATABASE_URL);
});

afterEach(async () => {
  for (const scenarioId of createdScenarioIds.splice(0)) {
    const positions = await db.selectFrom("paper_positions").select("id").where("scenario_id", "=", scenarioId).execute();
    const positionIds = positions.map((p) => p.id);
    if (positionIds.length > 0) {
      await db.deleteFrom("paper_fills").where("position_id", "in", positionIds).execute();
      await db.deleteFrom("paper_funding_payments").where("position_id", "in", positionIds).execute();
    }
    await db.deleteFrom("paper_equity_snapshots").where("scenario_id", "=", scenarioId).execute();
    await db.deleteFrom("paper_positions").where("scenario_id", "=", scenarioId).execute();
    await db.deleteFrom("paper_scenarios").where("id", "=", scenarioId).execute();
  }
});

afterAll(async () => db.destroy());

// ---------------------------------------------------------------------------
// Fixture helpers — mirror scenarioRunner.ts's own written shape exactly.
// ---------------------------------------------------------------------------

async function insertScenario(opts: {
  name: string;
  leverage: string;
  startingDeposit: string;
  status?: string;
}): Promise<bigint> {
  const row = await db
    .insertInto("paper_scenarios")
    .values({
      name: opts.name,
      leverage: opts.leverage,
      starting_deposit: opts.startingDeposit,
      status: opts.status ?? "completed",
      started_at: new Date(),
      stopped_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  createdScenarioIds.push(row.id);
  return row.id;
}

interface ClosedPositionFixture {
  scenarioId: bigint;
  symbol: string;
  leverage: string;
  spotQty: string;
  perpQty: string;
  openedAt: Date;
  closedAt: Date;
  entryPerpPrice: string;
  entryPerpFee: string;
  entrySpotPrice: string;
  entrySpotFee: string;
  exitPerpPrice: string;
  exitPerpFee: string;
  exitSpotPrice: string;
  exitSpotFee: string;
  fundingPayments?: { amount: string; paidAt: Date }[];
  /** Positive cost magnitude, same convention as paper_fills.fee — defaults to "0" (no slippage). */
  slippageCost?: string;
  /** Positive cost magnitude — defaults to "0" (no borrow, e.g. leverage=1). */
  borrowCost?: string;
}

async function insertClosedPosition(f: ClosedPositionFixture): Promise<bigint> {
  const position = await db
    .insertInto("paper_positions")
    .values({
      scenario_id: f.scenarioId,
      symbol: f.symbol,
      state: "CLOSED",
      spot_qty: f.spotQty,
      perp_qty: f.perpQty,
      leverage: f.leverage,
      entry_reasoning: "__TEST_FIXTURE__",
      opened_at: f.openedAt,
      closed_at: f.closedAt,
      slippage_cost: f.slippageCost ?? "0",
      borrow_cost: f.borrowCost ?? "0",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Same 4 (leg, side) pairs scenarioRunner.ts's openNewPosition/closePosition write.
  await db
    .insertInto("paper_fills")
    .values([
      {
        position_id: position.id,
        leg: "perp",
        side: "Sell",
        qty: f.perpQty,
        price: f.entryPerpPrice,
        fee: f.entryPerpFee,
        executed_at: f.openedAt,
      },
      {
        position_id: position.id,
        leg: "spot",
        side: "Buy",
        qty: f.spotQty,
        price: f.entrySpotPrice,
        fee: f.entrySpotFee,
        executed_at: f.openedAt,
      },
      {
        position_id: position.id,
        leg: "perp",
        side: "Buy",
        qty: f.perpQty,
        price: f.exitPerpPrice,
        fee: f.exitPerpFee,
        executed_at: f.closedAt,
      },
      {
        position_id: position.id,
        leg: "spot",
        side: "Sell",
        qty: f.spotQty,
        price: f.exitSpotPrice,
        fee: f.exitSpotFee,
        executed_at: f.closedAt,
      },
    ])
    .execute();

  if (f.fundingPayments && f.fundingPayments.length > 0) {
    await db
      .insertInto("paper_funding_payments")
      .values(
        f.fundingPayments.map((fp) => ({
          position_id: position.id,
          amount: fp.amount,
          rate: "0.0001",
          interval_minutes: 480,
          paid_at: fp.paidAt,
        })),
      )
      .execute();
  }

  return position.id;
}

async function insertSnapshots(scenarioId: bigint, points: { at: Date; totalEquity: string }[]): Promise<void> {
  await db
    .insertInto("paper_equity_snapshots")
    .values(
      points.map((p) => ({
        scenario_id: scenarioId,
        at: p.at,
        total_equity: p.totalEquity,
        margin_balance: p.totalEquity,
        is_peak: false,
      })),
    )
    .execute();
}

function csvLines(csv: string): string[] {
  expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM present
  const withoutBom = csv.slice(1);
  expect(withoutBom.includes("\r\n")).toBe(true); // RFC 4180 CRLF record separator
  const lines = withoutBom.split("\r\n");
  // buildCsv always ends with a trailing CRLF -> a trailing "" element.
  expect(lines[lines.length - 1]).toBe("");
  return lines.slice(0, -1);
}

// ---------------------------------------------------------------------------

describe("generateReports", () => {
  it(
    "produces exact column headers, a UTF-8 BOM + CRLF on both CSVs, and correctly RFC-4180-escapes a Cyrillic " +
      "scenario name containing a comma and an embedded quote (CSV) / a pipe character (markdown table)",
    async () => {
      const scenarioName = 'Тест "R1", A|B';
      const scenarioId = await insertScenario({ name: scenarioName, leverage: "1", startingDeposit: "500" });
      await insertClosedPosition({
        scenarioId,
        symbol: "__TEST_RPT_HDR__USDT",
        leverage: "1",
        spotQty: "1",
        perpQty: "1",
        openedAt: new Date("2026-01-01T00:00:00.000Z"),
        closedAt: new Date("2026-01-01T08:00:00.000Z"),
        entryPerpPrice: "100",
        entryPerpFee: "0.01",
        entrySpotPrice: "100",
        entrySpotFee: "0.01",
        exitPerpPrice: "100",
        exitPerpFee: "0.01",
        exitSpotPrice: "100",
        exitSpotFee: "0.01",
        fundingPayments: [{ amount: "1", paidAt: new Date("2026-01-01T04:00:00.000Z") }],
      });
      await insertSnapshots(scenarioId, [
        { at: new Date("2026-01-01T00:00:00.000Z"), totalEquity: "500" },
        { at: new Date("2026-01-01T08:00:00.000Z"), totalEquity: "500.96" },
      ]);

      const result = await generateReports(db, "hdr-run", [scenarioId]);

      // --- trades.csv ---
      const tradeLines = csvLines(result.tradesCsv);
      expect(tradeLines[0]).toBe(
        [
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
        ].join(","),
      );
      expect(tradeLines).toHaveLength(2); // header + 1 trade
      // Comma + embedded quote -> whole field quoted, internal quotes doubled (RFC 4180).
      expect(tradeLines[1]).toContain(`"Тест ""R1"", A|B"`);

      // --- equity curve csv ---
      const equityLines = csvLines(result.equityCurveCsv);
      expect(equityLines[0]).toBe(
        [
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
        ].join(","),
      );

      // --- summary markdown ---
      const md = result.summaryMarkdown;
      expect(md.startsWith("# Paper-trading report — run hdr-run")).toBe(true);
      expect(md).toContain(
        "| scenario_order | scenario_name | leverage_target | start_date | end_date | starting_deposit_usd | " +
          "ending_equity_usd | total_return_pct | funding_income_usd | basis_pnl_usd | fees_usd | slippage_usd | " +
          "borrow_cost_usd | net_pnl_usd | trade_count | win_rate_pct | max_drawdown_pct | " +
          "reality_adjusted_pnl_low_usd | reality_adjusted_pnl_high_usd | verdict |",
      );
      // Markdown escapes '|' (-> '\|'), but leaves commas/quotes alone — unlike the CSV's RFC 4180 quoting.
      expect(md).toContain('Тест "R1", A\\|B');
      expect(md.charCodeAt(0)).not.toBe(0xfeff); // markdown does NOT get a BOM, only the CSVs do
    },
  );

  it(
    "computes a per-trade P&L breakdown with no float-precision loss, using non-terminating-decimal fill prices " +
      "(the string values must round-trip exactly against an independently Big.js-computed expectation)",
    async () => {
      const scenarioId = await insertScenario({ name: "Сценарий В (точность)", leverage: "1", startingDeposit: "300" });

      const openedAt = new Date("2026-02-01T00:00:00.000Z");
      const closedAt = new Date("2026-02-03T06:00:00.000Z"); // 54 hours later

      const spotQty = new Big("3");
      const perpQty = new Big("3");
      const entryPerpPrice = new Big("100");
      const entrySpotPrice = new Big("99.97");
      const exitPerpPrice = new Big("101.5");
      const exitSpotPrice = new Big("101.13");
      const entryPerpFee = new Big("0.055");
      const entrySpotFee = new Big("0.09997");
      const exitPerpFee = new Big("0.05583");
      const exitSpotFee = new Big("0.10113");
      const funding1 = new Big("0.234567891234567891");
      const funding2 = new Big("0.1");

      await insertClosedPosition({
        scenarioId,
        symbol: "__TEST_RPT_PRECISION__USDT",
        leverage: "1",
        spotQty: spotQty.toString(),
        perpQty: perpQty.toString(),
        openedAt,
        closedAt,
        entryPerpPrice: entryPerpPrice.toString(),
        entryPerpFee: entryPerpFee.toString(),
        entrySpotPrice: entrySpotPrice.toString(),
        entrySpotFee: entrySpotFee.toString(),
        exitPerpPrice: exitPerpPrice.toString(),
        exitPerpFee: exitPerpFee.toString(),
        exitSpotPrice: exitSpotPrice.toString(),
        exitSpotFee: exitSpotFee.toString(),
        fundingPayments: [
          { amount: funding1.toString(), paidAt: new Date("2026-02-01T12:00:00.000Z") },
          { amount: funding2.toString(), paidAt: new Date("2026-02-02T12:00:00.000Z") },
        ],
      });
      await insertSnapshots(scenarioId, [{ at: openedAt, totalEquity: "300" }]);

      // Independently computed expectation, using the SAME shared formula
      // (execution/realizedPnl.ts's computeRealizedPnlBreakdown) reportGenerator.ts
      // itself calls — this is what actually exercises "no float-precision loss":
      // if reportGenerator.ts routed any of this through Number/parseFloat/toFixed
      // instead of staying in Big.js the whole way, these high-precision strings
      // would diverge from this expectation at the 15th+ significant digit.
      const entryBasis = entryPerpPrice.minus(entrySpotPrice).div(entrySpotPrice);
      const exitBasis = exitPerpPrice.minus(exitSpotPrice).div(exitSpotPrice);
      const entryLegNotional = spotQty.times(entrySpotPrice);
      const exitLegNotional = spotQty.times(exitSpotPrice);
      const totalFees = entryPerpFee.plus(entrySpotFee).plus(exitPerpFee).plus(exitSpotFee);
      const grossFunding = funding1.plus(funding2);
      const expectedBreakdown = computeRealizedPnlBreakdown({
        entryLegNotional,
        exitLegNotional,
        entryBasis,
        exitBasis,
        grossFundingCollected: grossFunding,
        totalFees,
        realizedSlippage: new Big(0),
      });
      const expectedNotional = perpQty.times(entryPerpPrice);
      const expectedNetPnlPct = expectedBreakdown.total.div(expectedNotional).times(100);

      const result = await generateReports(db, "precision-run", [scenarioId]);
      const lines = csvLines(result.tradesCsv);
      expect(lines).toHaveLength(2);
      const fields = lines[1]!.split(",");
      // scenario_id, scenario_name, trade_id, symbol, leverage_target, entry_at, exit_at,
      // hold_duration_hours, funding_usd, basis_pnl_usd, fees_usd, slippage_usd, borrow_cost_usd,
      // net_pnl_usd, net_pnl_pct_of_notional, result
      expect(fields[7]).toBe("54"); // hold_duration_hours
      expect(fields[8]).toBe(expectedBreakdown.fundingComponent.toString());
      expect(fields[9]).toBe(expectedBreakdown.basisComponent.toString());
      expect(fields[10]).toBe(expectedBreakdown.feesComponent.toString());
      expect(fields[11]).toBe("0"); // slippage_usd — fixture leaves slippage_cost at its "0" default
      expect(fields[12]).toBe("0"); // borrow_cost_usd — fixture leaves borrow_cost at its "0" default
      expect(fields[13]).toBe(expectedBreakdown.total.toString());
      expect(fields[14]).toBe(expectedNetPnlPct.toString());
      // This fixture's basis loss (perp rose relative to spot between entry and
      // exit) outweighs funding income net of fees — a genuine loss, not
      // hand-picked to be a round/positive number, which is the point: the
      // assertions above already pin the exact value independent of its sign.
      expect(expectedBreakdown.total.lt(0)).toBe(true);
      expect(fields[15]).toBe("loss");

      // Sanity: these values genuinely are NOT round/short decimals — proves the
      // fixture actually exercises high-precision division, not a degenerate case.
      expect(expectedBreakdown.basisComponent.toString().length).toBeGreaterThan(10);
    },
  );

  it(
    "reads real, non-zero slippage_usd/borrow_cost_usd back from paper_positions.slippage_cost/.borrow_cost " +
      "(instead of the old hardcoded-0 gap) and folds both into net_pnl_usd with the report's <= 0 cost convention",
    async () => {
      const scenarioId = await insertScenario({ name: "Сценарий Д (costs)", leverage: "3", startingDeposit: "500" });

      const openedAt = new Date("2026-03-01T00:00:00.000Z");
      const closedAt = new Date("2026-03-01T08:00:00.000Z");
      const slippageCost = new Big("2.345678");
      const borrowCost = new Big("1.123456");

      await insertClosedPosition({
        scenarioId,
        symbol: "__TEST_RPT_COSTS__USDT",
        leverage: "3",
        spotQty: "1",
        perpQty: "1",
        openedAt,
        closedAt,
        entryPerpPrice: "100",
        entryPerpFee: "0.055",
        entrySpotPrice: "100",
        entrySpotFee: "0.1",
        exitPerpPrice: "100",
        exitPerpFee: "0.055",
        exitSpotPrice: "100",
        exitSpotFee: "0.1",
        fundingPayments: [{ amount: "5", paidAt: openedAt }],
        slippageCost: slippageCost.toString(),
        borrowCost: borrowCost.toString(),
      });
      await insertSnapshots(scenarioId, [
        { at: openedAt, totalEquity: "500" },
        { at: closedAt, totalEquity: "500" },
      ]);

      const totalFees = new Big("0.055").plus("0.1").plus("0.055").plus("0.1");
      const expectedBreakdown = computeRealizedPnlBreakdown({
        entryLegNotional: new Big("100"),
        exitLegNotional: new Big("100"),
        entryBasis: new Big(0),
        exitBasis: new Big(0),
        grossFundingCollected: new Big("5"),
        totalFees,
        realizedSlippage: slippageCost,
      });
      const expectedBorrowCostUsd = borrowCost.times(-1);
      const expectedNetPnlUsd = expectedBreakdown.total.plus(expectedBorrowCostUsd);

      const result = await generateReports(db, "costs-run", [scenarioId]);
      const fields = csvLines(result.tradesCsv)[1]!.split(",");
      // ... funding_usd, basis_pnl_usd, fees_usd, slippage_usd, borrow_cost_usd, net_pnl_usd, ...
      expect(fields[11]).toBe(expectedBreakdown.slippageComponent.toString()); // slippage_usd (<= 0)
      expect(fields[12]).toBe(expectedBorrowCostUsd.toString()); // borrow_cost_usd (<= 0)
      expect(fields[13]).toBe(expectedNetPnlUsd.toString()); // net_pnl_usd

      // Same two figures must also roll up correctly into the summary markdown's totals.
      const md = result.summaryMarkdown;
      const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
      const cells = row.split("|").map((c) => c.trim());
      // ["", scenario_order, ..., fees_usd, slippage_usd, borrow_cost_usd, net_pnl_usd, ...]
      expect(cells[12]).toBe(expectedBreakdown.slippageComponent.toString());
      expect(cells[13]).toBe(expectedBorrowCostUsd.toString());
      expect(cells[14]).toBe(expectedNetPnlUsd.toString());
    },
  );

  it(
    "computes reality-adjusted P&L (0.5x/0.7x of NET p&l) and the entry-margin verdict correctly across a " +
      "confirmed scenario (all trades clear funding >= 2x fees, net P&L > 0) and a rejected one (negative net " +
      "P&L, funding below the 2x-fees margin, reasons listed)",
    async () => {
      const scenarioAId = await insertScenario({ name: "Сценарий А", leverage: "1", startingDeposit: "500" });
      const t0 = new Date("2026-04-01T00:00:00.000Z");
      const t1 = new Date("2026-04-01T01:00:00.000Z");
      for (const funding of ["1", "0.5", "0.3"]) {
        await insertClosedPosition({
          scenarioId: scenarioAId,
          symbol: `__TEST_RPT_A_${funding}__USDT`,
          leverage: "1",
          spotQty: "2",
          perpQty: "2",
          openedAt: t0,
          closedAt: t1,
          entryPerpPrice: "100",
          entryPerpFee: "0.01",
          entrySpotPrice: "100",
          entrySpotFee: "0.01",
          exitPerpPrice: "100",
          exitPerpFee: "0.01",
          exitSpotPrice: "100",
          exitSpotFee: "0.01",
          fundingPayments: [{ amount: funding, paidAt: t0 }],
        });
      }
      await insertSnapshots(scenarioAId, [
        { at: t0, totalEquity: "500" },
        { at: new Date("2026-04-02T00:00:00.000Z"), totalEquity: "501.68" },
      ]);

      const scenarioBId = await insertScenario({ name: "Сценарий Б", leverage: "2", startingDeposit: "500" });
      await insertClosedPosition({
        scenarioId: scenarioBId,
        symbol: "__TEST_RPT_B__USDT",
        leverage: "2",
        spotQty: "1",
        perpQty: "1",
        openedAt: new Date("2026-05-01T00:00:00.000Z"),
        closedAt: new Date("2026-05-01T05:30:00.000Z"),
        entryPerpPrice: "100",
        entryPerpFee: "0.05",
        entrySpotPrice: "100",
        entrySpotFee: "0.05",
        exitPerpPrice: "110",
        exitPerpFee: "0.055",
        exitSpotPrice: "100",
        exitSpotFee: "0.05",
        fundingPayments: [{ amount: "0.1", paidAt: new Date("2026-05-01T00:00:00.000Z") }],
      });
      await insertSnapshots(scenarioBId, [
        { at: new Date("2026-05-01T00:00:00.000Z"), totalEquity: "500" },
        { at: new Date("2026-05-01T06:00:00.000Z"), totalEquity: "489.895" },
      ]);

      const result = await generateReports(db, "verdict-run", [scenarioAId, scenarioBId]);
      const md = result.summaryMarkdown;
      const rowLines = md.split("\n").filter((l) => l.startsWith("| 1 |") || l.startsWith("| 2 |"));
      expect(rowLines).toHaveLength(2);
      const rowA = rowLines[0]!.split("|").map((c) => c.trim());
      const rowB = rowLines[1]!.split("|").map((c) => c.trim());
      // ["", scenario_order, scenario_name, leverage_target, start_date, end_date, starting_deposit_usd,
      //  ending_equity_usd, total_return_pct, funding_income_usd, basis_pnl_usd, fees_usd, slippage_usd,
      //  borrow_cost_usd, net_pnl_usd, trade_count, win_rate_pct, max_drawdown_pct,
      //  reality_adjusted_pnl_low_usd, reality_adjusted_pnl_high_usd, verdict, ""]

      // Scenario A: 3 wins, funding 1+0.5+0.3=1.8, fees 0.04*3=0.12, net = 1.8-0.12 = 1.68
      expect(rowA[1]).toBe("1");
      expect(rowA[2]).toBe("Сценарий А");
      expect(rowA[9]).toBe("1.8"); // funding_income_usd
      expect(rowA[10]).toBe("0"); // basis_pnl_usd (prices never moved)
      expect(rowA[11]).toBe("-0.12"); // fees_usd (cost, <= 0)
      expect(rowA[14]).toBe("1.68"); // net_pnl_usd
      expect(rowA[15]).toBe("3"); // trade_count
      expect(rowA[16]).toBe("100"); // win_rate_pct
      expect(rowA[18]).toBe("0.84"); // reality_adjusted_pnl_low_usd = 1.68 * 0.5
      expect(rowA[19]).toBe("1.176"); // reality_adjusted_pnl_high_usd = 1.68 * 0.7
      expect(rowA[20]).toBe("экономика входа подтверждена");

      // Scenario B: funding 0.1, basis -10, fees -0.205, net = 0.1 - 10 - 0.205 = -10.105
      expect(rowB[1]).toBe("2");
      expect(rowB[14]).toBe("-10.105"); // net_pnl_usd
      expect(rowB[18]).toBe("-5.0525"); // reality_adjusted_pnl_low_usd = -10.105 * 0.5
      expect(rowB[20]).toContain("не подтверждена");
      expect(rowB[20]).toContain("net_pnl_usd = -10.105");
      expect(rowB[20]).toContain("reality_adjusted_pnl_low_usd = -5.0525");
      expect(rowB[20]).toContain("0/1"); // 0 of 1 trades passed the entry-margin check
      expect(rowB[20]).toContain("2x fees");
    },
  );

  it(
    "rolls up per-scenario paper_equity_snapshots into one row per UTC calendar day (open/close/high/low), tracks " +
      "the running peak/drawdown/is_new_peak across days seeded from starting_deposit, and attributes daily " +
      "funding/fees to the day they actually occurred on",
    async () => {
      const scenarioId = await insertScenario({ name: "Сценарий Г (equity curve)", leverage: "1", startingDeposit: "1000" });

      const day1Open = new Date("2026-06-10T00:00:00.000Z");
      const day1High = new Date("2026-06-10T08:00:00.000Z");
      const day1Low = new Date("2026-06-10T16:00:00.000Z");
      const day1Close = new Date("2026-06-10T23:00:00.000Z");
      const day2Open = new Date("2026-06-11T02:00:00.000Z");
      const day2High = new Date("2026-06-11T12:00:00.000Z");
      const day2Close = new Date("2026-06-11T20:00:00.000Z");

      await insertSnapshots(scenarioId, [
        { at: day1Open, totalEquity: "1000" },
        { at: day1High, totalEquity: "1010.50" },
        { at: day1Low, totalEquity: "995.25" },
        { at: day1Close, totalEquity: "1005" },
        { at: day2Open, totalEquity: "1005" },
        { at: day2High, totalEquity: "1020.75" },
        { at: day2Close, totalEquity: "1018" },
      ]);

      // Position spans the day1/day2 midnight boundary, to test open_positions_count's overlap logic.
      const openedAt = new Date("2026-06-10T06:00:00.000Z");
      const closedAt = new Date("2026-06-11T04:00:00.000Z");
      await insertClosedPosition({
        scenarioId,
        symbol: "__TEST_RPT_EQCURVE__USDT",
        leverage: "1",
        spotQty: "0.1",
        perpQty: "0.1",
        openedAt,
        closedAt,
        entryPerpPrice: "50000",
        entryPerpFee: "1",
        entrySpotPrice: "49990",
        entrySpotFee: "1",
        exitPerpPrice: "50100",
        exitPerpFee: "1.002",
        exitSpotPrice: "50090",
        exitSpotFee: "1.0018",
        fundingPayments: [{ amount: "5", paidAt: new Date("2026-06-10T20:00:00.000Z") }],
      });

      const result = await generateReports(db, "eqcurve-run", [scenarioId]);
      const lines = csvLines(result.equityCurveCsv);
      expect(lines).toHaveLength(3); // header + 2 daily rows

      const day1 = lines[1]!.split(",");
      const day2 = lines[2]!.split(",");
      // scenario_id, scenario_name, date, equity_open_usd, equity_close_usd, equity_high_usd, equity_low_usd,
      // daily_pnl_usd, daily_funding_usd, daily_fees_usd, daily_borrow_cost_usd, open_positions_count,
      // cumulative_pnl_usd, drawdown_from_peak_pct, is_new_peak

      expect(day1[2]).toBe("2026-06-10");
      expect(day1[3]).toBe("1000"); // equity_open_usd
      expect(day1[4]).toBe("1005"); // equity_close_usd
      expect(day1[5]).toBe("1010.5"); // equity_high_usd
      expect(day1[6]).toBe("995.25"); // equity_low_usd
      expect(day1[7]).toBe("5"); // daily_pnl_usd = close - open
      expect(day1[8]).toBe("5"); // daily_funding_usd (the one funding payment landed on day1)
      expect(day1[9]).toBe("-2"); // daily_fees_usd = -(entry perp 1 + entry spot 1)
      expect(day1[10]).toBe("0"); // daily_borrow_cost_usd — known gap
      expect(day1[11]).toBe("1"); // open_positions_count (position opened at 06:00 day1)
      expect(day1[12]).toBe("5"); // cumulative_pnl_usd = 1005 - 1000
      // peak seeded at startingDeposit=1000; day1 high 1010.50 > 1000 -> new peak, drawdown from 1010.50 to close 1005.
      const day1Peak = new Big("1010.50");
      const expectedDay1Drawdown = day1Peak.minus("1005").div(day1Peak).times(100);
      expect(day1[13]).toBe(expectedDay1Drawdown.toString());
      expect(day1[14]).toBe("true"); // is_new_peak

      expect(day2[2]).toBe("2026-06-11");
      expect(day2[3]).toBe("1005"); // equity_open_usd
      expect(day2[4]).toBe("1018"); // equity_close_usd
      expect(day2[5]).toBe("1020.75"); // equity_high_usd
      expect(day2[6]).toBe("1005"); // equity_low_usd
      expect(day2[7]).toBe("13"); // daily_pnl_usd = 1018 - 1005
      expect(day2[8]).toBe("0"); // no funding on day2
      expect(day2[9]).toBe("-2.0038"); // -(exit perp 1.002 + exit spot 1.0018)
      expect(day2[11]).toBe("1"); // still counted open (closed_at 04:00 day2 > day2 start)
      expect(day2[12]).toBe("18"); // cumulative_pnl_usd = 1018 - 1000
      const day2Peak = new Big("1020.75");
      const expectedDay2Drawdown = day2Peak.minus("1018").div(day2Peak).times(100);
      expect(day2[13]).toBe(expectedDay2Drawdown.toString());
      expect(day2[14]).toBe("true"); // 1020.75 > previous peak 1010.50 -> also a new peak
    },
  );

  it("throws a clear error when a requested scenarioId does not exist, rather than silently omitting it", async () => {
    await expect(generateReports(db, "missing-run", [999999999999n])).rejects.toThrow(/paper_scenarios\.id=999999999999 not found/);
  });

  it("throws a clear error when a CLOSED position is missing one of its 4 expected fills, rather than reporting a wrong P&L", async () => {
    const scenarioId = await insertScenario({ name: "__TEST_RPT_BROKEN__", leverage: "1", startingDeposit: "500" });
    const position = await db
      .insertInto("paper_positions")
      .values({
        scenario_id: scenarioId,
        symbol: "__TEST_RPT_BROKEN__USDT",
        state: "CLOSED",
        spot_qty: "1",
        perp_qty: "1",
        leverage: "1",
        entry_reasoning: "__TEST_FIXTURE__",
        opened_at: new Date("2026-07-01T00:00:00.000Z"),
        closed_at: new Date("2026-07-01T01:00:00.000Z"),
        slippage_cost: "0",
        borrow_cost: "0",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // Only 1 of the 4 expected fills — a data-integrity problem this file must fail loudly on.
    await db
      .insertInto("paper_fills")
      .values({
        position_id: position.id,
        leg: "perp",
        side: "Sell",
        qty: "1",
        price: "100",
        fee: "0.01",
        executed_at: new Date("2026-07-01T00:00:00.000Z"),
      })
      .execute();

    await expect(generateReports(db, "broken-run", [scenarioId])).rejects.toThrow(/expected 4 fills/);
  });
});
