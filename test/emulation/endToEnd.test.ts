import Big from "big.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  runScenario,
  HOURLY_BORROW_RATE_FALLBACK,
  SPOT_TAKER_FEE_RATE_FALLBACK,
  PERP_TAKER_FEE_RATE_FALLBACK,
} from "../../src/emulation/scenarioRunner.js";
import type { ScenarioConfig } from "../../src/emulation/scenarioRunner.js";
import { generateReports } from "../../src/emulation/reportGenerator.js";
import { estimateSlippage } from "../../src/risk/liquidity.js";
import type { OrderbookLevel } from "../../src/market-data/types.js";
import { computeBorrowCost8h } from "../../src/emulation/borrowCost.js";
import { computeRealizedPnlBreakdown } from "../../src/execution/realizedPnl.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

/**
 * Backlog #37/#38 (Фаза 2 эмуляция): PIPELINE test, not a module test. Every
 * one of scenarioRunner.ts's own building blocks (equityEngine, borrowCost,
 * liquidation, paperPositionState) and reportGenerator.ts already have their
 * own unit tests, and scenarioRunner.test.ts/reportGenerator.test.ts already
 * cover each of THOSE two files in isolation (scenarioRunner.test.ts drives
 * `runScenario` against real market-data fixtures; reportGenerator.test.ts
 * drives `generateReports` against hand-inserted paper_* rows). None of those
 * exercise the SEAM between the two: does what `runScenario` actually did to
 * the account (its own returned `finalEquity`) agree with what
 * `generateReports` — reading the exact same DB rows back independently —
 * CLAIMS happened? A manual review recently found exactly this kind of seam
 * bug (per-trade slippage/borrow cost computed by scenarioRunner.ts but not
 * persisted, so reportGenerator.ts silently reported an upper-bound
 * net_pnl_usd) — this file's job is to make that class of bug fail a test
 * automatically instead of requiring another manual review to catch the next
 * one.
 *
 * Real local/test Postgres required (same convention as every other test in
 * test/emulation/) — DATABASE_URL must point at a migrated instance. No skip
 * on a missing DATABASE_URL.
 *
 * ============================================================================
 * FIXTURE DESIGN
 * ============================================================================
 * 3 symbols, 4 ticks (t0..t3, 1h apart). Two symbols ("LOSERA"/"LOSERB") carry
 * a predicted funding rate below both risk/economics.ts's ENTRY_FLOOR_R8H and
 * isPremiumDriven's threshold — they exist only to prove the pipeline runs a
 * real multi-symbol universe through `pickBestCandidate` and correctly opens
 * NOTHING for a non-qualifying candidate, not to contribute any P&L. The third
 * symbol ("WINNER") is engineered to open at t0 and never voluntarily exit
 * (constant price -> zero basis divergence, constant predicted rate -> never
 * dips below its own entry-APR hysteresis floor or turns negative), so it is
 * force-closed at range end (t3) — the same "SCENARIO_END" path
 * scenarioRunner.test.ts's own look-ahead fixture exercises.
 *
 * `positionSizeUsd` is fixed at $100 (overriding the adaptive equity-fraction
 * default) purely so the position's notional is a known, controlled number
 * this test can reuse in its own independent P&L computation below — nothing
 * about the invariant being tested requires a fixed size, only convenience.
 *
 * `leverage: 2` (ScenarioConfig's OWN "perp margin leverage" meaning — NOT
 * risk/leverage.ts's effective-leverage ratio, see scenarioRunner.ts's own
 * doc comment) is deliberately > 1 so `borrowCost.ts`'s
 * `computeBorrowCost8h` returns a non-zero rate (at leverage=1 it is
 * algebraically exactly zero — see that function's own doc comment) — this
 * test wants a REAL non-zero borrow_cost_usd to flow through the pipeline,
 * not a vacuously-zero one that would pass even if the persistence gap
 * reappeared. Likewise the entry orderbook is deliberately NOT infinitely
 * deep (unlike scenarioRunner.test.ts's own DEEP_BOOK_QTY convention) — two
 * levels per side, engineered to spill a small, computable amount of the
 * $100 target notional onto the second (worse) price level, so
 * entrySpotSlippageBp/entryPerpSlippageBp — and therefore slippage_usd — are
 * also genuinely non-zero, while staying comfortably under
 * risk/liquidity.ts's MAX_SLIPPAGE_BP (0.05%) ceiling so the entry isn't
 * vetoed.
 *
 * Two `kind='settled'` funding rows (rate 0.002 then 0.003, 30 minutes into
 * each of the first two ticks the position is held) give the position real
 * funding income, comfortably larger than its total fees+slippage+borrow
 * cost, so the trade nets a real, non-degenerate profit — not a scenario
 * hand-picked to net exactly zero, which would hide a sign error in either
 * code path.
 *
 * Every "expected" figure below is computed by calling the SAME shared pure
 * functions (`estimateSlippage`, `computeBorrowCost8h`,
 * `computeRealizedPnlBreakdown`) production code itself calls, with inputs
 * this fixture fully controls — the same "recompute independently via the
 * shared formula" convention reportGenerator.test.ts's own precision test
 * uses, rather than hand-typed decimal literals. This is NOT testing those
 * functions' own correctness (each has its own unit tests) — it is testing
 * that scenarioRunner.ts and reportGenerator.ts both wire them together the
 * SAME way, using the SAME persisted numbers.
 *
 * ============================================================================
 * OBSERVED AT THE TIME THIS TEST WAS WRITTEN (informational — see task's own
 * open_questions ask)
 * ============================================================================
 * A separate, concurrent session was mid-fix on exactly the slippage/borrow-
 * cost persistence gap this test targets. As read at the time this file was
 * written: scenarioRunner.ts's closePosition already persists
 * `slippage_cost`/`borrow_cost` onto paper_positions, the migration already
 * has both columns, and reportGenerator.ts's buildTradeRow already reads them
 * back (and throws if either is NULL on a CLOSED position) — so the gap
 * appears to already be fixed end-to-end as of this writing. Two stale
 * leftovers were also observed, NEITHER touched by this file (out of scope —
 * this task only adds a new test file):
 *   1. reportGenerator.ts's own buildSummaryMarkdown footer text still
 *      literally states "slippage_usd and borrow_cost_usd are always '0'" —
 *      no longer accurate given the code above it now reads real persisted
 *      values; a stale doc string, not a data bug.
 *   2. test/emulation/reportGenerator.test.ts's own fixture helper
 *      (`insertClosedPosition`) never sets slippage_cost/borrow_cost, and its
 *      "precision" test still asserts `fields[11]`/`fields[12]` (slippage_usd/
 *      borrow_cost_usd) equal "0" — given buildTradeRow's current NULL-check,
 *      that fixture leaves both columns NULL on a CLOSED position, which
 *      looks like it would now make that specific `it` block throw rather
 *      than return "0". This file does not fix that test (not this task's
 *      file to edit) — flagging it here since it is exactly the kind of
 *      stale-test risk this end-to-end file exists to catch structurally
 *      instead of by manual review.
 * If either of those has since been reconciled, or if the persistence gap
 * turns out NOT fully fixed when this file is actually run, the core
 * assertion below (report net_pnl_usd vs scenarioRunner's own finalEquity)
 * will fail loudly rather than silently pass — that is the point of this
 * file.
 */

const WINNER = "__TEST_E2E_WINNER__USDT";
const LOSER_A = "__TEST_E2E_LOSERA__USDT";
const LOSER_B = "__TEST_E2E_LOSERB__USDT";
const ALL_TEST_SYMBOLS = [WINNER, LOSER_A, LOSER_B];

const GENEROUS_TURNOVER = "500000000"; // above PARAMS-CONSERVATIVE.md §4's floors (perp 100M, spot 20M)

const T0 = new Date("2099-06-01T00:00:00.000Z");
const T1 = new Date("2099-06-01T01:00:00.000Z");
const T2 = new Date("2099-06-01T02:00:00.000Z");
const T3 = new Date("2099-06-01T03:00:00.000Z");
const TICKS = [T0, T1, T2, T3];

const ONE_HOUR_MS = 60 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * ONE_HOUR_MS;

// ---------------------------------------------------------------------------
// Fixture helpers — same insertion shape as scenarioRunner.test.ts's own.
// ---------------------------------------------------------------------------

async function insertTickerPair(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  price: string,
): Promise<void> {
  await db
    .insertInto("tickers")
    .values([
      {
        symbol,
        category: "linear",
        last_price: price,
        mark_price: price,
        index_price: price,
        volume_24h: null,
        turnover_24h: GENEROUS_TURNOVER,
        fetched_at: fetchedAt,
      },
      {
        symbol,
        category: "spot",
        last_price: price,
        mark_price: null,
        index_price: null,
        volume_24h: null,
        turnover_24h: GENEROUS_TURNOVER,
        fetched_at: fetchedAt,
      },
    ])
    .execute();
}

async function insertOrderbookLevels(
  db: Kysely<Database>,
  symbol: string,
  category: "linear" | "spot",
  side: "bid" | "ask",
  fetchedAt: Date,
  levels: OrderbookLevel[],
): Promise<void> {
  await db
    .insertInto("orderbook_levels")
    .values(
      levels.map((l, i) => ({
        symbol,
        category,
        side,
        level_index: i,
        price: l.price.toString(),
        qty: l.qty.toString(),
        fetched_at: fetchedAt,
      })),
    )
    .execute();
}

async function insertPredictedFunding(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  rate: string,
  nextFundingAt: Date,
): Promise<void> {
  await db
    .insertInto("funding_rates")
    .values({
      symbol,
      kind: "predicted",
      rate,
      interval_minutes: 480,
      funding_timestamp_ms: String(nextFundingAt.getTime()),
      fetched_at: fetchedAt,
    })
    .execute();
}

async function insertSettledFunding(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  rate: string,
  fundingTimestampMs: number,
): Promise<void> {
  await db
    .insertInto("funding_rates")
    .values({
      symbol,
      kind: "settled",
      rate,
      interval_minutes: 480,
      funding_timestamp_ms: String(fundingTimestampMs),
      fetched_at: fetchedAt,
    })
    .execute();
}

async function cleanupScenario(db: Kysely<Database>, scenarioId: bigint): Promise<void> {
  const positions = await db
    .selectFrom("paper_positions")
    .select("id")
    .where("scenario_id", "=", scenarioId)
    .execute();
  const positionIds = positions.map((p) => p.id);
  if (positionIds.length > 0) {
    await db.deleteFrom("paper_fills").where("position_id", "in", positionIds).execute();
    await db.deleteFrom("paper_funding_payments").where("position_id", "in", positionIds).execute();
  }
  await db.deleteFrom("paper_equity_snapshots").where("scenario_id", "=", scenarioId).execute();
  await db.deleteFrom("paper_positions").where("scenario_id", "=", scenarioId).execute();
  await db.deleteFrom("paper_scenarios").where("id", "=", scenarioId).execute();
}

// ---------------------------------------------------------------------------
// Report-parsing helpers — same slicing convention as reportGenerator.test.ts.
// ---------------------------------------------------------------------------

function csvLines(csv: string): string[] {
  expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM present
  const withoutBom = csv.slice(1);
  expect(withoutBom.includes("\r\n")).toBe(true); // RFC 4180 CRLF record separator
  const lines = withoutBom.split("\r\n");
  expect(lines[lines.length - 1]).toBe(""); // buildCsv always ends with a trailing CRLF
  return lines.slice(0, -1);
}

function parseMarkdownRow(md: string, order: number): string[] {
  const line = md.split("\n").find((l) => l.startsWith(`| ${String(order)} |`));
  if (!line) throw new Error(`No markdown row found for scenario_order=${String(order)}`);
  return line.split("|").map((c) => c.trim());
}

describe("emulation pipeline (scenarioRunner -> reportGenerator) end to end", () => {
  let db: Kysely<Database>;
  const scenarioIdsToClean: bigint[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    for (const id of scenarioIdsToClean.splice(0)) {
      await cleanupScenario(db, id);
    }
    await db.deleteFrom("tickers").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
    await db.deleteFrom("funding_rates").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
    await db.deleteFrom("orderbook_levels").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
  });

  afterAll(async () => db.destroy());

  it(
    "opens exactly one position (WINNER), rejects the two low-rate candidates, force-closes at range end, and " +
      "produces a report whose net_pnl_usd, trade_count and win_rate agree EXACTLY with what runScenario's own " +
      "return value and the persisted paper_* rows actually did — not just an upper-bound approximation of it",
    async () => {
      const PRICE = new Big("100");
      const startingDeposit = new Big("500");
      const positionSizeUsd = new Big("100");
      const leverage = new Big("2");

      // --- WINNER: qualifies, opens at t0, held flat through t3, force-closed ---
      for (const t of TICKS) {
        await insertTickerPair(db, WINNER, t, PRICE.toString());
        await insertPredictedFunding(db, WINNER, t, "0.0015", new Date(t.getTime() + 6 * ONE_HOUR_MS));
      }

      const perpBidLevels: OrderbookLevel[] = [
        { price: new Big("100"), qty: new Big("0.5") }, // $50 at best price
        { price: new Big("99.98"), qty: new Big("10") }, // deep enough for the remaining $50, 2bp worse
      ];
      const spotAskLevels: OrderbookLevel[] = [
        { price: new Big("100"), qty: new Big("0.5") },
        { price: new Big("100.02"), qty: new Big("10") },
      ];
      await insertOrderbookLevels(db, WINNER, "linear", "bid", T0, perpBidLevels);
      await insertOrderbookLevels(db, WINNER, "spot", "ask", T0, spotAskLevels);

      // Two settlements while the position is held (t0+30m, t1+30m) — real,
      // non-zero funding income, comfortably covering fees+slippage+borrow.
      const settle1Ms = T0.getTime() + 30 * 60 * 1000;
      const settle2Ms = T1.getTime() + 30 * 60 * 1000;
      await insertSettledFunding(db, WINNER, T0, "0.002", settle1Ms);
      await insertSettledFunding(db, WINNER, T0, "0.003", settle2Ms);

      // --- LOSER_A / LOSER_B: real data, but rate is below BOTH
      // risk/economics.ts's ENTRY_FLOOR_R8H (0.0002) and isPremiumDriven's
      // 0.0005 threshold — must never open, proving the multi-symbol
      // universe is actually evaluated (not just a single-symbol path).
      for (const symbol of [LOSER_A, LOSER_B]) {
        await insertTickerPair(db, symbol, T0, PRICE.toString());
        await insertPredictedFunding(db, symbol, T0, "0.0001", new Date(T0.getTime() + 6 * ONE_HOUR_MS));
      }

      const config: ScenarioConfig = {
        name: "__test_e2e_pipeline__",
        leverage,
        startingDeposit,
        symbols: [LOSER_A, WINNER, LOSER_B], // deliberately not in any special order
        startAt: T0,
        endAt: T3,
        positionSizeUsd,
      };

      // =======================================================================
      // 1. Run the actual simulation.
      // =======================================================================
      const result = await runScenario(db, config);
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.ticksProcessed).toBe(4);
      expect(result.positionsOpened).toBe(1);
      expect(result.positionsClosed).toBe(1);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(positions).toHaveLength(1);
      const position = positions[0]!;
      expect(position.symbol).toBe(WINNER);
      expect(position.state).toBe("CLOSED");
      expect(position.opened_at?.getTime()).toBe(T0.getTime());
      expect(position.closed_at?.getTime()).toBe(T3.getTime()); // force-closed at range end, not an earlier voluntary exit
      // The very gap this file targets: these must be REAL persisted costs,
      // not the pre-fix hardcoded/never-written NULL.
      expect(position.slippage_cost).not.toBeNull();
      expect(position.borrow_cost).not.toBeNull();
      expect(new Big(position.slippage_cost!).gt(0)).toBe(true);
      expect(new Big(position.borrow_cost!).gt(0)).toBe(true);

      const scenarioRow = await db
        .selectFrom("paper_scenarios")
        .selectAll()
        .where("id", "=", result.scenarioId)
        .executeTakeFirstOrThrow();
      expect(scenarioRow.status).toBe("completed");

      // =======================================================================
      // 2. Independently recompute the expected P&L via the SAME shared pure
      //    functions production code uses (not hand-typed decimal literals —
      //    see this file's own top-level doc comment).
      // =======================================================================
      const perpQty = new Big("1"); // $100 / $100 price, default 0.001 qtyStep -> exactly 1
      const spotQty = new Big("1");

      const perpSlip = estimateSlippage(perpBidLevels, positionSizeUsd);
      const spotSlip = estimateSlippage(spotAskLevels, positionSizeUsd);
      expect(perpSlip.exhausted).toBe(false);
      expect(spotSlip.exhausted).toBe(false);
      expect(perpSlip.slippageBp.gt(0)).toBe(true);
      expect(spotSlip.slippageBp.gt(0)).toBe(true);

      // scenarioRunner.ts's closePosition: entryBp * qty * (entryPrice + exitPrice), both legs.
      const expectedSlippageCost = perpSlip.slippageBp
        .times(perpQty)
        .times(PRICE.plus(PRICE))
        .plus(spotSlip.slippageBp.times(spotQty).times(PRICE.plus(PRICE)));

      // scenarioRunner.ts's accrueBorrowCost, called once per tick the position
      // is already open (t1, t2, t3 — NOT t0, since it opens mid-t0) with the
      // constant $100 notional (price never moves) over 1h elapsed each time.
      const notionalConst = perpQty.times(PRICE);
      const rate8h = computeBorrowCost8h(leverage, notionalConst, HOURLY_BORROW_RATE_FALLBACK);
      const perAccrualIncrement = rate8h.times(notionalConst).times(ONE_HOUR_MS).div(EIGHT_HOURS_MS);
      const expectedBorrowCostAccrued = perAccrualIncrement.times(3);

      // applySettledFundingUpTo: amount = rate * perpQty * markPriceAtSettlement (always $100 here).
      const expectedGrossFunding = new Big("0.002")
        .times(perpQty)
        .times(PRICE)
        .plus(new Big("0.003").times(perpQty).times(PRICE));

      const entryPerpFee = perpQty.times(PRICE).times(PERP_TAKER_FEE_RATE_FALLBACK);
      const entrySpotFee = spotQty.times(PRICE).times(SPOT_TAKER_FEE_RATE_FALLBACK);
      const exitPerpFee = entryPerpFee; // exit price == entry price in this fixture
      const exitSpotFee = entrySpotFee;
      const expectedTotalFees = entryPerpFee.plus(entrySpotFee).plus(exitPerpFee).plus(exitSpotFee);

      const expectedBreakdown = computeRealizedPnlBreakdown({
        entryLegNotional: spotQty.times(PRICE),
        exitLegNotional: spotQty.times(PRICE),
        entryBasis: new Big(0), // perp mark == spot price at every tick in this fixture
        exitBasis: new Big(0),
        grossFundingCollected: expectedGrossFunding,
        totalFees: expectedTotalFees,
        realizedSlippage: expectedSlippageCost,
      });
      // Not part of computeRealizedPnlBreakdown's own total — scenarioRunner.ts
      // (closePosition) and reportGenerator.ts (buildTradeRow) both subtract/add
      // it separately, see this file's own top doc comment.
      const expectedNetPnl = expectedBreakdown.total.minus(expectedBorrowCostAccrued);

      expect(expectedNetPnl.gt(0)).toBe(true); // sanity: this fixture is a real, non-degenerate profit, not a wash

      // =======================================================================
      // 3. THE CORE INVARIANT: scenarioRunner's own bookkeeping (finalEquity)
      //    must agree with reportGenerator's independent reconstruction from
      //    the persisted rows. This does NOT depend on step 2's arithmetic
      //    being right — it is a pure self-consistency check between two code
      //    paths reading the same DB state.
      // =======================================================================
      const actualEquityChange = result.finalEquity.minus(startingDeposit);

      const reportResult = await generateReports(db, "__test_e2e_run__", [result.scenarioId]);

      const tradeLines = csvLines(reportResult.tradesCsv);
      expect(tradeLines).toHaveLength(2); // header + 1 trade
      const tradeFields = tradeLines[1]!.split(",");
      // scenario_id, scenario_name, trade_id, symbol, leverage_target, entry_at, exit_at,
      // hold_duration_hours, funding_usd, basis_pnl_usd, fees_usd, slippage_usd, borrow_cost_usd,
      // net_pnl_usd, net_pnl_pct_of_notional, result
      expect(tradeFields[3]).toBe(WINNER);
      expect(tradeFields[7]).toBe("3"); // hold_duration_hours: t0 -> t3

      const reportedFundingUsd = new Big(tradeFields[8]!);
      const reportedFeesUsd = new Big(tradeFields[10]!);
      const reportedSlippageUsd = new Big(tradeFields[11]!);
      const reportedBorrowCostUsd = new Big(tradeFields[12]!);
      const reportedNetPnlUsd = new Big(tradeFields[13]!);

      // slippage_usd/borrow_cost_usd are reported as costs (<= 0) — the exact
      // opposite-sign version of the "known gap" symptom (previously
      // hardcoded/silently-zero) would show up here as these being exactly "0"
      // even though the position's own persisted slippage_cost/borrow_cost
      // (asserted non-zero above) are not.
      expect(reportedSlippageUsd.lt(0)).toBe(true);
      expect(reportedBorrowCostUsd.lt(0)).toBe(true);
      expect(reportedFundingUsd.toString()).toBe(expectedGrossFunding.toString());
      expect(reportedFeesUsd.toString()).toBe(expectedTotalFees.times(-1).toString());
      expect(reportedSlippageUsd.toString()).toBe(expectedSlippageCost.times(-1).toString());
      expect(reportedBorrowCostUsd.toString()).toBe(expectedBorrowCostAccrued.times(-1).toString());
      expect(reportedNetPnlUsd.toString()).toBe(expectedNetPnl.toString());

      const expectedResult = expectedNetPnl.gt(0) ? "win" : expectedNetPnl.lt(0) ? "loss" : "breakeven";
      expect(tradeFields[15]).toBe(expectedResult);

      // The invariant itself: what runScenario's own return value says
      // happened to the account, vs. what generateReports independently
      // reconstructs from the DB rows runScenario wrote. If these ever
      // diverge (e.g. the slippage/borrow-cost persistence gap reappears, or
      // reappears partially), THIS is the assertion that must fail.
      expect(reportedNetPnlUsd.toString()).toBe(actualEquityChange.toString());

      // =======================================================================
      // 4. Summary markdown: trade_count/win_rate must agree with
      //    scenarioRunner's own positionsOpened/positionsClosed, and its own
      //    net_pnl_usd column (independently summed from the same trade rows)
      //    must ALSO agree with the invariant above.
      // =======================================================================
      const summaryRow = parseMarkdownRow(reportResult.summaryMarkdown, 1);
      // ["", scenario_order, scenario_name, leverage_target, start_date, end_date, starting_deposit_usd,
      //  ending_equity_usd, total_return_pct, funding_income_usd, basis_pnl_usd, fees_usd, slippage_usd,
      //  borrow_cost_usd, net_pnl_usd, trade_count, win_rate_pct, max_drawdown_pct,
      //  reality_adjusted_pnl_low_usd, reality_adjusted_pnl_high_usd, verdict, ""]
      expect(summaryRow[15]).toBe(String(result.positionsClosed)); // trade_count
      expect(summaryRow[16]).toBe("100"); // win_rate_pct — the sole trade nets positive
      expect(new Big(summaryRow[14]!).toString()).toBe(actualEquityChange.toString()); // net_pnl_usd
      expect(new Big(summaryRow[7]!).toString()).toBe(result.finalEquity.toString()); // ending_equity_usd

      // =======================================================================
      // 5. Structural smoke check on the equity-curve CSV — reportGenerator.test.ts
      //    already covers its detailed daily-rollup math, this just confirms the
      //    pipeline produced non-empty, well-formed output for it too.
      // =======================================================================
      const equityLines = csvLines(reportResult.equityCurveCsv);
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
      expect(equityLines.length).toBeGreaterThan(1); // header + at least 1 daily row
    },
  );
});
