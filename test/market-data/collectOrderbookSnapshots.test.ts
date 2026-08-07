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
const SYM_A = "__TEST_OB_A__USDT";
const SYM_B = "__TEST_OB_B__USDT";
const SYM_LARGE = "__TEST_OB_LARGE__USDT";

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
    await db
      .deleteFrom("orderbook_levels")
      .where("symbol", "in", [SYM, SYM_A, SYM_B, SYM_LARGE])
      .execute();
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

  it("dedupes a symbol that fails BOTH categories against another that fully succeeds, in a multi-symbol universe", async () => {
    const universe2 = [
      { symbol: SYM_A, fundingIntervalMinutes: 480 },
      { symbol: SYM_B, fundingIntervalMinutes: 480 },
    ];

    // SYM_A succeeds on both categories.
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "linear" && q.symbol === SYM_A)
      .reply(200, okResponse({ s: SYM_A, b: [["1", "1"]], a: [["2", "1"]], ts: 1, u: 1, seq: 1, cts: 1 }));
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "spot" && q.symbol === SYM_A)
      .reply(200, okResponse({ s: SYM_A, b: [["1", "1"]], a: [["2", "1"]], ts: 1, u: 1, seq: 1, cts: 1 }));

    // SYM_B fails on BOTH categories -> 2 entries in `failed`, but only 1 unique
    // failed symbol once `failed` is deduped by `symbol.split(":")[0]`.
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "linear" && q.symbol === SYM_B)
      .replyWithError(new Error("linear down"));
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "spot" && q.symbol === SYM_B)
      .replyWithError(new Error("spot down"));

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectOrderbookSnapshots(client, db, universe2, new RateLimiter(0));

    expect(result.written).toBe(4); // SYM_A: linear (1 bid + 1 ask) + spot (1 bid + 1 ask); SYM_B contributed nothing.
    expect(result.failed.sort()).toEqual([`${SYM_B}:linear`, `${SYM_B}:spot`]);
    // 2 universe symbols, 1 of which failed entirely. The dedup Set must collapse
    // SYM_B's 2 failed (symbol,category) entries into 1 unique failed symbol, so
    // symbolsCollected = 2 - 1 = 1. A naive `universe.length - failed.length`
    // (2 - 2) would wrongly report 0 collected symbols here.
    expect(result.symbolsCollected).toBe(1);
  });

  it("chunks the insert across multiple INSERT_CHUNK_SIZE (1000) batches without dropping or duplicating the boundary rows", async () => {
    const universeLarge = [{ symbol: SYM_LARGE, fundingIntervalMinutes: 480 }];
    // 500 distinctly-priced levels per side -> linear alone produces exactly
    // INSERT_CHUNK_SIZE (500 bids + 500 asks = 1000) rows, filling chunk #1
    // to the exact boundary.
    const levels500: [string, string][] = Array.from({ length: 500 }, (_, i) => [String(i), "1"]);

    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "linear")
      .reply(200, okResponse({ s: SYM_LARGE, b: levels500, a: levels500, ts: 1, u: 1, seq: 1, cts: 1 }));
    // spot adds exactly 1 more row, which must land alone in a second chunk —
    // this is what exercises a second iteration of the `i += INSERT_CHUNK_SIZE`
    // insert loop.
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ s: SYM_LARGE, b: [["9999", "1"]], a: [], ts: 1, u: 1, seq: 1, cts: 1 }));

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectOrderbookSnapshots(client, db, universeLarge, new RateLimiter(0));

    expect(result.written).toBe(1001);
    expect(result.failed).toEqual([]);

    const rows = await db
      .selectFrom("orderbook_levels")
      .selectAll()
      .where("symbol", "=", SYM_LARGE)
      .execute();
    // Every row from both chunks actually landed in the DB — an off-by-one in
    // the slice bounds would either drop the last row of chunk #1 or the sole
    // row of chunk #2, or (with `<=`) attempt an extra empty insert.
    expect(rows).toHaveLength(1001);

    // The very last row of chunk #1 (linear ask, level_index 499) must be present.
    const lastOfChunk1 = rows.find(
      (r) => r.category === "linear" && r.side === "ask" && r.level_index === 499,
    );
    expect(lastOfChunk1?.price).toBe("499");

    // The sole row of chunk #2 (spot bid, level_index 0) must also be present.
    const onlyRowOfChunk2 = rows.find((r) => r.category === "spot" && r.side === "bid");
    expect(onlyRowOfChunk2?.level_index).toBe(0);
    expect(onlyRowOfChunk2?.price).toBe("9999");
  });
});
