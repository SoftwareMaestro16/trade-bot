import Big from "big.js";
import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { RateLimiter } from "../../src/exchange/rateLimiter.js";
import {
  collectLongShortRatio,
  latestLongShortRatioAtOrBefore,
} from "../../src/market-data/collectLongShortRatio.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const SYM_A = "__TEST_LSR_A__USDT";
const SYM_B = "__TEST_LSR_B__USDT";
const SYM_C = "__TEST_LSR_C__USDT";

async function insertRatio(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  buyRatio: string,
  sellRatio: string,
): Promise<void> {
  await db
    .insertInto("long_short_ratio")
    .values({
      symbol,
      buy_ratio: buyRatio,
      sell_ratio: sellRatio,
      data_period: "5min",
      data_timestamp_ms: String(fetchedAt.getTime()),
      fetched_at: fetchedAt,
    })
    .execute();
}

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

afterEach(() => nock.cleanAll());

describe("collectLongShortRatio", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });
  afterEach(async () => {
    await db.deleteFrom("long_short_ratio").where("symbol", "in", [SYM_A, SYM_B, SYM_C]).execute();
  });
  afterAll(async () => db.destroy());

  it("writes the latest ratio per symbol and paces calls through the rate limiter", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/account-ratio")
      .query((q) => q.symbol === SYM_A)
      .reply(200, okResponse({ list: [{ symbol: SYM_A, buyRatio: "0.6123", sellRatio: "0.3877", timestamp: "1785960000000" }] }));
    nock(TESTNET_BASE)
      .get("/v5/market/account-ratio")
      .query((q) => q.symbol === SYM_B)
      .reply(200, okResponse({ list: [{ symbol: SYM_B, buyRatio: "0.51", sellRatio: "0.49", timestamp: "1785960000000" }] }));

    const client = new PublicExchangeClient({ testnet: true });
    const limiter = new RateLimiter(0);
    const universe = [
      { symbol: SYM_A, fundingIntervalMinutes: 480 },
      { symbol: SYM_B, fundingIntervalMinutes: 480 },
    ];

    const result = await collectLongShortRatio(client, db, universe, limiter, "5min");

    expect(result).toEqual({ written: 2, failed: [] });

    const rows = await db
      .selectFrom("long_short_ratio")
      .selectAll()
      .where("symbol", "in", [SYM_A, SYM_B])
      .orderBy("symbol")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.buy_ratio).toBe("0.6123");
    expect(rows[0]?.data_period).toBe("5min");
  });

  it("isolates a per-symbol failure: the rest of the sweep still completes and reports it", async () => {
    nock(TESTNET_BASE).get("/v5/market/account-ratio").query((q) => q.symbol === SYM_A).replyWithError(new Error("timeout"));
    nock(TESTNET_BASE)
      .get("/v5/market/account-ratio")
      .query((q) => q.symbol === SYM_B)
      .reply(200, okResponse({ list: [{ symbol: SYM_B, buyRatio: "0.51", sellRatio: "0.49", timestamp: "1785960000000" }] }));

    const client = new PublicExchangeClient({ testnet: true });
    const limiter = new RateLimiter(0);
    const universe = [
      { symbol: SYM_A, fundingIntervalMinutes: 480 },
      { symbol: SYM_B, fundingIntervalMinutes: 480 },
    ];

    const result = await collectLongShortRatio(client, db, universe, limiter, "5min");

    expect(result.written).toBe(1);
    expect(result.failed).toEqual([SYM_A]);
  });

  describe("latestLongShortRatioAtOrBefore", () => {
    it("picks the most recent row at-or-before t (inclusive boundary wins over earlier candidates, later row excluded, other symbol excluded), parsed to Big per ADR-003", async () => {
      const t = new Date("2026-01-01T00:00:00.000Z");
      // Two earlier candidates that also satisfy fetched_at <= t: proves ORDER BY
      // fetched_at DESC LIMIT 1 picks the latest qualifying row, not an arbitrary
      // or first-inserted one.
      await insertRatio(db, SYM_A, new Date(t.getTime() - 2 * 3600_000), "0.10", "0.90");
      await insertRatio(db, SYM_A, new Date(t.getTime() - 3600_000), "0.20", "0.80");
      // Exact boundary — fetched_at === t must be included (inclusive `<=`), and
      // is the most recent qualifying row so it must be the one returned.
      await insertRatio(db, SYM_A, t, "0.6123", "0.3877");
      // Strictly after t — must never win even though it's chronologically closest.
      await insertRatio(db, SYM_A, new Date(t.getTime() + 1), "0.99", "0.01");
      // Same instant, different symbol — must not leak into SYM_A's result.
      await insertRatio(db, SYM_B, t, "0.55", "0.45");

      const result = await latestLongShortRatioAtOrBefore(db, SYM_A, t);

      expect(result).toBeDefined();
      expect(result?.buyRatio).toBeInstanceOf(Big);
      expect(result?.sellRatio).toBeInstanceOf(Big);
      expect(result?.buyRatio.toString()).toBe("0.6123");
      expect(result?.sellRatio.toString()).toBe("0.3877");
    });

    it("returns undefined when the symbol has no rows at all, and still undefined once its only row is strictly after t", async () => {
      const t = new Date("2026-01-01T00:00:00.000Z");

      expect(await latestLongShortRatioAtOrBefore(db, SYM_C, t)).toBeUndefined();

      await insertRatio(db, SYM_C, new Date(t.getTime() + 1), "0.5", "0.5");

      expect(await latestLongShortRatioAtOrBefore(db, SYM_C, t)).toBeUndefined();
    });
  });
});
