import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { RateLimiter } from "../../src/exchange/rateLimiter.js";
import { collectLongShortRatio } from "../../src/market-data/collectLongShortRatio.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const SYM_A = "__TEST_LSR_A__USDT";
const SYM_B = "__TEST_LSR_B__USDT";

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
    await db.deleteFrom("long_short_ratio").where("symbol", "in", [SYM_A, SYM_B]).execute();
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
});
