import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { RateLimiter } from "../../src/exchange/rateLimiter.js";
import { collectOrderbookSnapshots } from "../../src/market-data/collectOrderbookSnapshots.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const SYM = "__TEST_OB__USDT";

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

afterEach(() => nock.cleanAll());

describe("collectOrderbookSnapshots", () => {
  let db: Kysely<Database>;
  const universe = [{ symbol: SYM, fundingIntervalMinutes: 480 }];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });
  afterEach(async () => {
    await db.deleteFrom("orderbook_levels").where("symbol", "=", SYM).execute();
  });
  afterAll(async () => db.destroy());

  it("normalizes bid/ask levels into rows for both linear and spot, preserving exact price/qty strings", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "linear")
      .reply(
        200,
        okResponse({ s: SYM, b: [["64725.123456789", "1.5"], ["64724.9", "2.0"]], a: [["64726.1", "0.5"]], ts: 1785960000000, u: 1, seq: 1, cts: 1785960000000 }),
      );
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ s: SYM, b: [["64720.0", "1.0"]], a: [["64721.0", "1.0"]], ts: 1785960000000, u: 1, seq: 1, cts: 1785960000000 }));

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectOrderbookSnapshots(client, db, universe, new RateLimiter(0));

    // linear: 2 bids + 1 ask = 3; spot: 1 bid + 1 ask = 2; total 5.
    expect(result).toEqual({ written: 5, failed: [], symbolsCollected: 1 });

    const rows = await db
      .selectFrom("orderbook_levels")
      .selectAll()
      .where("symbol", "=", SYM)
      .where("category", "=", "linear")
      .where("side", "=", "bid")
      .orderBy("level_index")
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.level_index).toBe(0);
    expect(rows[0]?.price).toBe("64725.123456789");
    expect(rows[1]?.level_index).toBe(1);
    expect(rows[1]?.price).toBe("64724.9");
  });

  it("isolates a per-category failure without losing the other category's data", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "linear")
      .replyWithError(new Error("timeout"));
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ s: SYM, b: [["1", "1"]], a: [["2", "1"]], ts: 1, u: 1, seq: 1, cts: 1 }));

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectOrderbookSnapshots(client, db, universe, new RateLimiter(0));

    expect(result.written).toBe(2); // spot bid + ask only
    expect(result.failed).toEqual([`${SYM}:linear`]);
    // A symbol with even one category missing must not count as collected —
    // this is what FR-109 gap detection reads, so it must reflect the real gap.
    expect(result.symbolsCollected).toBe(0);
  });
});
