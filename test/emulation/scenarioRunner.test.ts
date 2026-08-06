import Big from "big.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { runScenario } from "../../src/emulation/scenarioRunner.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

/**
 * Real local/test Postgres required (same pattern as
 * test/market-data/collectionDigest.test.ts) — DATABASE_URL must point at a
 * migrated instance. No skip on a missing DATABASE_URL: a silently-skipped
 * test that never ran is worse than a loud failure (PROJECT.md's "ни одного
 * проглоченного исключения" ethos, applied to test infrastructure too).
 */

const ALL_TEST_SYMBOLS = [
  "__TEST_SCN_LOOKAHEAD__USDT",
  "__TEST_SCN_MULTIA__USDT",
  "__TEST_SCN_MULTIB__USDT",
  "__TEST_SCN_MULTIC__USDT",
];

const DEEP_BOOK_QTY = "100000"; // $10,000,000 notional at price=100 — far more than any test's ~$100 targetNotional, so slippageBp stays exactly 0.
const GENEROUS_TURNOVER = "500000000"; // above both PARAMS-CONSERVATIVE.md §4 floors (perp 100M, spot 20M)

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

async function insertDeepBook(db: Kysely<Database>, symbol: string, fetchedAt: Date, price: string): Promise<void> {
  await db
    .insertInto("orderbook_levels")
    .values([
      { symbol, category: "linear", side: "bid", level_index: 0, price, qty: DEEP_BOOK_QTY, fetched_at: fetchedAt },
      { symbol, category: "spot", side: "ask", level_index: 0, price, qty: DEEP_BOOK_QTY, fetched_at: fetchedAt },
    ])
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

describe("runScenario", () => {
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
    "never opens a position on a predicted rate that only turns favorable partway through the range, even though a " +
      "settled row for the SAME event (with an earlier funding_timestamp_ms) is already in the table from the start " +
      "— proves entry decisions read kind='predicted' at the tick's own fetched_at, never kind='settled' (look-ahead)",
    async () => {
      const symbol = "__TEST_SCN_LOOKAHEAD__USDT";
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const t1 = new Date("2026-01-01T01:00:00.000Z");
      const t2 = new Date("2026-01-01T02:00:00.000Z"); // the tick where the predicted rate turns favorable
      const t3 = new Date("2026-01-01T03:00:00.000Z");
      const t4 = new Date("2026-01-01T04:00:00.000Z");
      const ticks = [t0, t1, t2, t3, t4];

      // provably-below-floor: below both ENTRY_FLOOR_R8H (0.0002) and the
      // premium-driven gate (0.0005) — risk/index.ts must deny every candidate here.
      const LOW_RATE = "0.0001";
      // provably-above-floor: comfortably clears both gates AND the K=2.0
      // round-trip payback threshold at expectedHoldIntervals=9 (3 days / 8h).
      const HIGH_RATE = "0.001";
      const PRICE = "100";

      for (const t of ticks) {
        await insertTickerPair(db, symbol, t, PRICE);
      }
      await insertDeepBook(db, symbol, t0, PRICE);

      // Predicted rate: LOW at t0/t1, flips to HIGH exactly at t2 and stays HIGH.
      const nextFunding = (t: Date) => new Date(t.getTime() + 6 * 60 * 60 * 1000); // 6h out — outside FUNDING_SETTLEMENT_BLACKOUT
      await insertPredictedFunding(db, symbol, t0, LOW_RATE, nextFunding(t0));
      await insertPredictedFunding(db, symbol, t1, LOW_RATE, nextFunding(t1));
      await insertPredictedFunding(db, symbol, t2, HIGH_RATE, nextFunding(t2));
      await insertPredictedFunding(db, symbol, t3, HIGH_RATE, nextFunding(t3));
      await insertPredictedFunding(db, symbol, t4, HIGH_RATE, nextFunding(t4));

      // THE TRAP: a settled row for an event that, per its funding_timestamp_ms,
      // "happened" BEFORE t0 (before the scenario even starts) — but carries the
      // HIGH rate. A buggy entry path that consulted kind='settled' instead of (or
      // in addition to) kind='predicted' would see a favorable rate from the very
      // first tick. The correct implementation never reads kind='settled' for an
      // entry decision at all.
      await db
        .insertInto("funding_rates")
        .values({
          symbol,
          kind: "settled",
          rate: HIGH_RATE,
          interval_minutes: 480,
          funding_timestamp_ms: String(t0.getTime() - 60 * 60 * 1000),
          fetched_at: t0,
        })
        .execute();

      const result = await runScenario(db, {
        name: "__test_lookahead__",
        leverage: new Big("1"),
        startingDeposit: new Big("500"),
        symbols: [symbol],
        startAt: t0,
        endAt: t4,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.ticksProcessed).toBe(5);
      expect(result.positionsOpened).toBe(1);
      expect(result.positionsClosed).toBe(1); // force-closed at range end (t4) — no exit trigger fires before then

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(positions).toHaveLength(1);
      const position = positions[0]!;
      expect(position.symbol).toBe(symbol);

      // closePosition persists both real per-trade cost figures (not left only
      // in-memory — see reportGenerator.ts's dependency on these columns). Both
      // are exactly "0" in THIS fixture specifically: DEEP_BOOK_QTY makes
      // estimateSlippage's slippageBp exactly 0, and leverage=1 makes
      // computeBorrowCost8h's borrowed fraction exactly 0 by construction
      // (emulation/borrowCost.ts's own doc comment) — not a null/missing value.
      expect(position.slippage_cost).not.toBeNull();
      expect(new Big(position.slippage_cost!).toString()).toBe("0");
      expect(position.borrow_cost).not.toBeNull();
      expect(new Big(position.borrow_cost!).toString()).toBe("0");

      // The core assertion: opened_at is t2 (first tick the PREDICTED rate turned
      // favorable) — never t0 or t1, despite the settled row's earlier timestamp.
      expect(position.opened_at).not.toBeNull();
      expect(position.opened_at?.getTime()).toBe(t2.getTime());
      expect(position.opened_at?.getTime()).toBeGreaterThan(t1.getTime());

      // Redundant-but-explicit: zero positions with any opened_at before t2.
      const prematureOpens = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .where("opened_at", "<", t2)
        .execute();
      expect(prematureOpens).toHaveLength(0);

      const scenarioRow = await db
        .selectFrom("paper_scenarios")
        .selectAll()
        .where("id", "=", result.scenarioId)
        .executeTakeFirst();
      expect(scenarioRow?.status).toBe("completed");
      expect(scenarioRow?.stopped_at).not.toBeNull();

      const snapshots = await db
        .selectFrom("paper_equity_snapshots")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(snapshots.length).toBeGreaterThanOrEqual(5);
    },
  );

  it(
    "opens exactly ONE position when multiple symbols qualify at the same tick (RR-22), and it is the top-ranked " +
      "candidate by yieldOnEquity — proves strategy/rankCandidates.ts integration, not just single-symbol plumbing",
    async () => {
      const symA = "__TEST_SCN_MULTIA__USDT"; // highest rate -> highest yield -> must win
      const symB = "__TEST_SCN_MULTIB__USDT";
      const symC = "__TEST_SCN_MULTIC__USDT";
      const symbols = [symA, symB, symC];

      const t0 = new Date("2026-02-01T00:00:00.000Z");
      const t1 = new Date("2026-02-01T01:00:00.000Z");
      const PRICE = "100";
      const nextFunding = new Date(t0.getTime() + 6 * 60 * 60 * 1000);

      for (const symbol of symbols) {
        await insertTickerPair(db, symbol, t0, PRICE);
        await insertDeepBook(db, symbol, t0, PRICE);
      }
      // All three clear every risk/index.ts gate, but at DIFFERENT r8h rates —
      // deterministic ranking: A > B > C.
      await insertPredictedFunding(db, symA, t0, "0.0015", nextFunding);
      await insertPredictedFunding(db, symB, t0, "0.0012", nextFunding);
      await insertPredictedFunding(db, symC, t0, "0.0010", nextFunding);

      const result = await runScenario(db, {
        name: "__test_max_one_position__",
        leverage: new Big("1"),
        startingDeposit: new Big("500"),
        symbols: [symC, symA, symB], // deliberately NOT in rank order — proves ranking, not array order, decides the winner
        startAt: t0,
        endAt: t1,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.positionsOpened).toBe(1);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();

      // RR-22: exactly one row, never one per qualifying symbol.
      expect(positions).toHaveLength(1);
      expect(positions[0]!.symbol).toBe(symA);
    },
  );
});
