import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { collectTickers } from "../../src/market-data/collectTickers.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const TEST_SYMBOL = "__TEST_TICKERS__USDT";
const OTHER_SYMBOL = "__TEST_TICKERS_OTHER__USDT"; // present on exchange, NOT in our universe
const LINEAR_ONLY_SYMBOL = "__TEST_TICKERS_LINEAR_ONLY__USDT"; // in universe, spot response missing it this cycle
const SPOT_ONLY_SYMBOL = "__TEST_TICKERS_SPOT_ONLY__USDT"; // in universe, linear response missing it this cycle

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

afterEach(() => {
  nock.cleanAll();
});

describe("collectTickers (against a real local Postgres, mocked Bybit responses)", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    const symbols = [TEST_SYMBOL, OTHER_SYMBOL, LINEAR_ONLY_SYMBOL, SPOT_ONLY_SYMBOL];
    await db.deleteFrom("tickers").where("symbol", "in", symbols).execute();
    await db.deleteFrom("funding_rates").where("symbol", "in", symbols).execute();
    await db.deleteFrom("open_interest").where("symbol", "in", symbols).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("writes tickers + predicted funding + open interest for universe symbols only, exact strings preserved", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "linear")
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [
            {
              symbol: TEST_SYMBOL,
              lastPrice: "64725.123456789012345678", // more precision than float64 holds exactly
              indexPrice: "64720.11",
              markPrice: "64722.22",
              volume24h: "1000.5",
              turnover24h: "64000000",
              openInterest: "500.25",
              fundingRate: "0.0002",
              nextFundingTime: "1785960000000",
            },
            // Not in our universe (no matching spot pair) -> must be dropped, not written.
            { symbol: OTHER_SYMBOL, lastPrice: "1", indexPrice: "1", markPrice: "1", volume24h: "1", turnover24h: "1", openInterest: "1", fundingRate: "0.0001", nextFundingTime: "1" },
          ],
        }),
      );

    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "spot")
      .reply(
        200,
        okResponse({
          category: "spot",
          list: [
            { symbol: TEST_SYMBOL, lastPrice: "64718.9", volume24h: "500", turnover24h: "32000000" },
          ],
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const universe = [{ symbol: TEST_SYMBOL, fundingIntervalMinutes: 480 }];

    const result = await collectTickers(client, db, universe);

    expect(result).toEqual({ tickersWritten: 2, fundingRatesWritten: 1, openInterestWritten: 1, symbolsCollected: 1 });

    const tickerRows = await db
      .selectFrom("tickers")
      .selectAll()
      .where("symbol", "=", TEST_SYMBOL)
      .execute();
    expect(tickerRows).toHaveLength(2);

    const linearRow = tickerRows.find((r) => r.category === "linear");
    expect(linearRow?.last_price).toBe("64725.123456789012345678");
    expect(linearRow?.mark_price).toBe("64722.22");

    const spotRow = tickerRows.find((r) => r.category === "spot");
    expect(spotRow?.last_price).toBe("64718.9");
    expect(spotRow?.mark_price).toBeNull();

    const fundingRows = await db
      .selectFrom("funding_rates")
      .selectAll()
      .where("symbol", "=", TEST_SYMBOL)
      .execute();
    expect(fundingRows).toHaveLength(1);
    expect(fundingRows[0]?.kind).toBe("predicted");
    expect(fundingRows[0]?.rate).toBe("0.0002");
    // RSK-25: interval comes from the universe (instruments-info), not parsed from the ticker.
    expect(fundingRows[0]?.interval_minutes).toBe(480);
    expect(fundingRows[0]?.funding_timestamp_ms).toBe("1785960000000");

    const oiRows = await db
      .selectFrom("open_interest")
      .selectAll()
      .where("symbol", "=", TEST_SYMBOL)
      .execute();
    expect(oiRows).toHaveLength(1);
    expect(oiRows[0]?.open_interest).toBe("500.25");

    // The symbol outside the universe must never reach the database (FR-108).
    const otherRows = await db.selectFrom("tickers").selectAll().where("symbol", "=", OTHER_SYMBOL).execute();
    expect(otherRows).toHaveLength(0);
  });

  it("writes nothing and returns zero counts when the universe is empty (FM-07: a valid outcome, not an error)", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "linear")
      .reply(200, okResponse({ category: "linear", list: [] }));
    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ category: "spot", list: [] }));

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectTickers(client, db, []);

    expect(result).toEqual({ tickersWritten: 0, fundingRatesWritten: 0, openInterestWritten: 0, symbolsCollected: 0 });
  });

  it("symbolsCollected reflects per-symbol linear+spot intersection, not row count, when a cycle is missing half its responses for some universe symbols (FR-109)", async () => {
    // Universe has 3 symbols. This cycle: TEST_SYMBOL gets both linear+spot,
    // LINEAR_ONLY_SYMBOL is missing from the spot response, SPOT_ONLY_SYMBOL is
    // missing from the linear response. tickersWritten (4 of a possible 6 rows)
    // looks like decent coverage; symbolsCollected must expose that only 1 of 3
    // universe symbols actually got full linear+spot coverage this cycle.
    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "linear")
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [
            { symbol: TEST_SYMBOL, lastPrice: "1", indexPrice: "1", markPrice: "1", volume24h: "1", turnover24h: "1", openInterest: "1", fundingRate: "0.0001", nextFundingTime: "1" },
            { symbol: LINEAR_ONLY_SYMBOL, lastPrice: "2", indexPrice: "2", markPrice: "2", volume24h: "2", turnover24h: "2", openInterest: "2", fundingRate: "0.0002", nextFundingTime: "2" },
            // SPOT_ONLY_SYMBOL deliberately absent here: linear response missed it this cycle.
          ],
        }),
      );

    nock(TESTNET_BASE)
      .get("/v5/market/tickers")
      .query((q) => q.category === "spot")
      .reply(
        200,
        okResponse({
          category: "spot",
          list: [
            { symbol: TEST_SYMBOL, lastPrice: "1", volume24h: "1", turnover24h: "1" },
            { symbol: SPOT_ONLY_SYMBOL, lastPrice: "3", volume24h: "3", turnover24h: "3" },
            // LINEAR_ONLY_SYMBOL deliberately absent here: spot response missed it this cycle.
          ],
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const universe = [
      { symbol: TEST_SYMBOL, fundingIntervalMinutes: 480 },
      { symbol: LINEAR_ONLY_SYMBOL, fundingIntervalMinutes: 480 },
      { symbol: SPOT_ONLY_SYMBOL, fundingIntervalMinutes: 480 },
    ];

    const result = await collectTickers(client, db, universe);

    // 4 ticker rows written (TEST_SYMBOL x2, LINEAR_ONLY_SYMBOL linear, SPOT_ONLY_SYMBOL spot)
    // could misleadingly read as ~near-full coverage by row count alone, but only
    // TEST_SYMBOL actually cleared both category feeds this cycle.
    expect(result).toEqual({
      tickersWritten: 4,
      fundingRatesWritten: 2, // linear-only loop: TEST_SYMBOL + LINEAR_ONLY_SYMBOL
      openInterestWritten: 2, // same linear-only loop
      symbolsCollected: 1, // only TEST_SYMBOL is in both linearSymbols and spotSymbols
    });

    const linearOnlyTickers = await db
      .selectFrom("tickers")
      .selectAll()
      .where("symbol", "=", LINEAR_ONLY_SYMBOL)
      .execute();
    expect(linearOnlyTickers).toHaveLength(1);
    expect(linearOnlyTickers[0]?.category).toBe("linear");

    const spotOnlyTickers = await db
      .selectFrom("tickers")
      .selectAll()
      .where("symbol", "=", SPOT_ONLY_SYMBOL)
      .execute();
    expect(spotOnlyTickers).toHaveLength(1);
    expect(spotOnlyTickers[0]?.category).toBe("spot");
  });
});
