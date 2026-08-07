import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  runLongShortRatioCycle,
  runOrderbookCycle,
  runSettledFundingCycle,
  runTickersCycle,
} from "../../src/collector/collectionTasks.js";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { RateLimiter } from "../../src/exchange/rateLimiter.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const SYM_TICKERS = "__TEST_COLLECTOR_TICKERS__USDT";
const SYM_OB = "__TEST_COLLECTOR_OB__USDT";
const SYM_LSR = "__TEST_COLLECTOR_LSR__USDT";
const SYM_SETTLED = "__TEST_COLLECTOR_SETTLED__USDT";

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

async function maxId(db: Kysely<Database>): Promise<bigint> {
  const row = await db
    .selectFrom("collection_runs")
    .select(({ fn }) => fn.max("id").as("max_id"))
    .executeTakeFirst();
  return row?.max_id ?? 0n;
}

afterEach(() => nock.cleanAll());

/**
 * These four functions are thin wiring extracted verbatim out of
 * collector.ts main()'s per-collector scheduleRepeating task bodies (see
 * src/collector/collectionTasks.ts's own doc comment) — each just calls the
 * already-independently-tested market-data/collect*.ts function and maps its
 * result into runCollectionCycle's `symbolsCollected`. These tests exist to
 * pin down THAT mapping (already covered indirectly by collectX.test.ts +
 * collectionRun.test.ts, but not together, end-to-end, the way collector.ts
 * actually wires them), not to re-test collect*.ts's own request/response
 * handling.
 */
describe("collector/collectionTasks", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });
  afterEach(async () => {
    const symbols = [SYM_TICKERS, SYM_OB, SYM_LSR, SYM_SETTLED];
    await db.deleteFrom("tickers").where("symbol", "in", symbols).execute();
    await db.deleteFrom("funding_rates").where("symbol", "in", symbols).execute();
    await db.deleteFrom("open_interest").where("symbol", "in", symbols).execute();
    await db.deleteFrom("orderbook_levels").where("symbol", "in", symbols).execute();
    await db.deleteFrom("long_short_ratio").where("symbol", "in", symbols).execute();
  });
  afterAll(async () => db.destroy());

  it("runTickersCycle records collectTickers's symbolsCollected in collection_runs", async () => {
    const universe = [{ symbol: SYM_TICKERS, fundingIntervalMinutes: 480 }];
    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "linear")
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [
            {
              symbol: SYM_TICKERS,
              lastPrice: "1",
              indexPrice: "1",
              markPrice: "1",
              volume24h: "1",
              turnover24h: "1",
              openInterest: "1",
              fundingRate: "0.0001",
              nextFundingTime: "1785960000000",
            },
          ],
        }),
      );
    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ category: "spot", list: [{ symbol: SYM_TICKERS, lastPrice: "1", volume24h: "1", turnover24h: "1" }] }));

    const client = new PublicExchangeClient({ testnet: true });
    const before = await maxId(db);
    await runTickersCycle(client, db, universe);

    const rows = await db.selectFrom("collection_runs").selectAll().where("id", ">", before).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.symbols_collected).toBe(1); // both linear+spot present for the one universe symbol
    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });

  it("runOrderbookCycle records collectOrderbookSnapshots's symbolsCollected in collection_runs", async () => {
    const universe = [{ symbol: SYM_OB, fundingIntervalMinutes: 480 }];
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "linear")
      .reply(200, okResponse({ s: SYM_OB, b: [["1", "1"]], a: [["2", "1"]], ts: 1, u: 1, seq: 1, cts: 1 }));
    nock(TESTNET_BASE)
      .get("/v5/market/orderbook")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ s: SYM_OB, b: [["1", "1"]], a: [["2", "1"]], ts: 1, u: 1, seq: 1, cts: 1 }));

    const client = new PublicExchangeClient({ testnet: true });
    const before = await maxId(db);
    await runOrderbookCycle(client, db, universe, new RateLimiter(0));

    const rows = await db.selectFrom("collection_runs").selectAll().where("id", ">", before).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.symbols_collected).toBe(1);
    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });

  it("runLongShortRatioCycle records collectLongShortRatio's `written` count, not a failed-derived count", async () => {
    const universe = [{ symbol: SYM_LSR, fundingIntervalMinutes: 480 }];
    nock(TESTNET_BASE)
      .get("/v5/market/account-ratio")
      .query((q) => q.symbol === SYM_LSR)
      .reply(200, okResponse({ list: [{ symbol: SYM_LSR, buyRatio: "0.6", sellRatio: "0.4", timestamp: "1785960000000" }] }));

    const client = new PublicExchangeClient({ testnet: true });
    const before = await maxId(db);
    await runLongShortRatioCycle(client, db, universe, new RateLimiter(0));

    const rows = await db.selectFrom("collection_runs").selectAll().where("id", ">", before).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.symbols_collected).toBe(1); // `written`, matching collectLongShortRatio's own result
    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });

  it("runSettledFundingCycle records universe.length - failed.length, not collectSettledFunding's `written`", async () => {
    const universe = [{ symbol: SYM_SETTLED, fundingIntervalMinutes: 480 }];
    nock(TESTNET_BASE)
      .get("/v5/market/funding/history")
      .query(true)
      .reply(
        200,
        okResponse({
          list: [
            { symbol: SYM_SETTLED, fundingRate: "0.0001", fundingRateTimestamp: "1785944000000" },
            { symbol: SYM_SETTLED, fundingRate: "0.0002", fundingRateTimestamp: "1785958400000" },
          ],
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const before = await maxId(db);
    await runSettledFundingCycle(client, db, universe, new RateLimiter(0));

    const rows = await db.selectFrom("collection_runs").selectAll().where("id", ">", before).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    // 1 universe symbol, 0 failed -> 1, even though `written` (2 settlement rows) differs.
    expect(rows[0]?.symbols_collected).toBe(1);
    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });
});
