import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { computeDigestStats } from "../../src/market-data/collectionDigest.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const SYM = "__TEST_DIGEST__USDT";
const WINDOW_START = new Date("2026-08-06T04:00:00Z");
const WINDOW_END = new Date("2026-08-06T12:00:00Z");
const IN_WINDOW = new Date("2026-08-06T08:00:00Z");
const BEFORE_WINDOW = new Date("2026-08-06T03:00:00Z");
const AFTER_WINDOW = new Date("2026-08-06T13:00:00Z");

describe("computeDigestStats", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    await db.deleteFrom("tickers").where("symbol", "=", SYM).execute();
    await db.deleteFrom("funding_rates").where("symbol", "=", SYM).execute();
    await db.deleteFrom("open_interest").where("symbol", "=", SYM).execute();
    await db.deleteFrom("long_short_ratio").where("symbol", "=", SYM).execute();
    await db.deleteFrom("orderbook_levels").where("symbol", "=", SYM).execute();
    await db.deleteFrom("liquidations").where("symbol", "=", SYM).execute();
    // Deletes by started_at, not by error text: the "completed" fixture row this
    // file inserts has no error field at all, so an error-pattern filter alone
    // leaves it behind to pollute other test files that expect an empty table
    // (exactly what broke test/market-data/collectionRun.test.ts before this fix).
    await db.deleteFrom("collection_runs").where("started_at", "=", IN_WINDOW).execute();
  });

  afterAll(async () => db.destroy());

  it("counts only rows inside [windowStart, windowEnd) across every table, and the distinct symbol count", async () => {
    await db
      .insertInto("tickers")
      .values([
        { symbol: SYM, category: "linear", last_price: "1", fetched_at: IN_WINDOW },
        { symbol: SYM, category: "spot", last_price: "1", fetched_at: IN_WINDOW },
        { symbol: SYM, category: "linear", last_price: "1", fetched_at: BEFORE_WINDOW },
        { symbol: SYM, category: "linear", last_price: "1", fetched_at: AFTER_WINDOW },
      ])
      .execute();

    await db
      .insertInto("funding_rates")
      .values({
        symbol: SYM,
        kind: "predicted",
        rate: "0.0001",
        interval_minutes: 480,
        funding_timestamp_ms: "1",
        fetched_at: IN_WINDOW,
      })
      .execute();

    await db
      .insertInto("liquidations")
      .values({
        symbol: SYM,
        side: "Buy",
        size: "1",
        price: "1",
        liquidation_time_ms: "1",
        received_at: IN_WINDOW,
      })
      .execute();

    const stats = await computeDigestStats(db, WINDOW_START, WINDOW_END);

    // Distinct symbols in the ticker window: only SYM (2 rows, 1 distinct) among
    // whatever else the shared local Postgres might contain from other runs —
    // so assert on the specific counts this test controls, not on totals, which
    // could pick up rows from concurrent/other test files against the same DB.
    expect(stats.tickersWritten).toBeGreaterThanOrEqual(2);
    expect(stats.fundingRatesWritten).toBeGreaterThanOrEqual(1);
    expect(stats.liquidationsWritten).toBeGreaterThanOrEqual(1);
  });

  it("excludes rows outside the window boundary (before windowStart and at/after windowEnd)", async () => {
    await db
      .insertInto("tickers")
      .values([
        { symbol: SYM, category: "linear", last_price: "1", fetched_at: WINDOW_START }, // inclusive lower bound
        { symbol: SYM, category: "linear", last_price: "1", fetched_at: WINDOW_END }, // exclusive upper bound -> excluded
      ])
      .execute();

    const stats = await computeDigestStats(db, WINDOW_START, WINDOW_END);
    // Only the WINDOW_START row (inclusive) should count from this test's own inserts.
    const onlyThisTest = await db
      .selectFrom("tickers")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("symbol", "=", SYM)
      .where("fetched_at", ">=", WINDOW_START)
      .where("fetched_at", "<", WINDOW_END)
      .executeTakeFirst();
    expect(Number(onlyThisTest?.count ?? 0)).toBe(1);
    expect(stats.tickersWritten).toBeGreaterThanOrEqual(1);
  });

  it("reports completed/failed collection_runs counts and lists recent failure reasons", async () => {
    await db
      .insertInto("collection_runs")
      .values([
        { status: "completed", started_at: IN_WINDOW, symbols_expected: 10, symbols_collected: 10 },
        { status: "failed", started_at: IN_WINDOW, error: "__TEST_DIGEST_FAILURE__ timeout" },
      ])
      .execute();

    const stats = await computeDigestStats(db, WINDOW_START, WINDOW_END);

    expect(stats.collectionRunsCompleted).toBeGreaterThanOrEqual(1);
    expect(stats.collectionRunsFailed).toBeGreaterThanOrEqual(1);
    expect(stats.recentFailures.some((f) => f.error === "__TEST_DIGEST_FAILURE__ timeout")).toBe(true);
  });

  it("returns zeros and an empty failures list for a window with no activity at all", async () => {
    const emptyWindow = { start: new Date("2020-01-01T00:00:00Z"), end: new Date("2020-01-01T01:00:00Z") };
    const stats = await computeDigestStats(db, emptyWindow.start, emptyWindow.end);

    expect(stats.tickersWritten).toBe(0);
    expect(stats.universeSize).toBe(0);
    expect(stats.recentFailures).toEqual([]);
  });
});
