import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { computeTradeableUniverse } from "../../src/market-data/universe.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

afterEach(() => {
  nock.cleanAll();
});

describe("computeTradeableUniverse", () => {
  it("keeps only Trading LinearPerpetual USDT symbols that also have a Trading USDT spot pair (FR-108)", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "linear")
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [
            { symbol: "BTCUSDT", contractType: "LinearPerpetual", status: "Trading", quoteCoin: "USDT", fundingInterval: 480 },
            // FM-14: LinearFutures must not enter the funding universe — they don't pay funding.
            { symbol: "BTCUSDT-25DEC26", contractType: "LinearFutures", status: "Trading", quoteCoin: "USDT", fundingInterval: 480 },
            // Not Trading -> excluded.
            { symbol: "DELISTEDUSDT", contractType: "LinearPerpetual", status: "Closed", quoteCoin: "USDT", fundingInterval: 480 },
            // Not USDT-quoted -> excluded.
            { symbol: "BTCPERP", contractType: "LinearPerpetual", status: "Trading", quoteCoin: "USDC", fundingInterval: 480 },
            // No matching spot pair -> excluded by the intersection, not by this filter.
            { symbol: "NOSPOTUSDT", contractType: "LinearPerpetual", status: "Trading", quoteCoin: "USDT", fundingInterval: 240 },
          ],
          nextPageCursor: "",
        }),
      );

    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "spot")
      .reply(
        200,
        okResponse({
          category: "spot",
          list: [
            { symbol: "BTCUSDT", status: "Trading", quoteCoin: "USDT" },
            { symbol: "DELISTEDUSDT", status: "Trading", quoteCoin: "USDT" },
          ],
          nextPageCursor: "",
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const universe = await computeTradeableUniverse(client);

    expect(universe).toEqual([{ symbol: "BTCUSDT", fundingIntervalMinutes: 480 }]);
  });

  it("follows nextPageCursor until exhausted instead of silently truncating the universe", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "linear" && !q.cursor)
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [{ symbol: "AUSDT", contractType: "LinearPerpetual", status: "Trading", quoteCoin: "USDT", fundingInterval: 480 }],
          nextPageCursor: "page2",
        }),
      );
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "linear" && q.cursor === "page2")
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [{ symbol: "BUSDT", contractType: "LinearPerpetual", status: "Trading", quoteCoin: "USDT", fundingInterval: 240 }],
          nextPageCursor: "",
        }),
      );
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "spot")
      .reply(
        200,
        okResponse({
          category: "spot",
          list: [
            { symbol: "AUSDT", status: "Trading", quoteCoin: "USDT" },
            { symbol: "BUSDT", status: "Trading", quoteCoin: "USDT" },
          ],
          nextPageCursor: "",
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const universe = await computeTradeableUniverse(client);

    expect(universe).toEqual([
      { symbol: "AUSDT", fundingIntervalMinutes: 480 },
      { symbol: "BUSDT", fundingIntervalMinutes: 240 },
    ]);
  });

  it("returns an empty universe (not an error) when nothing qualifies — a valid Phase 1 outcome (RISK-REGISTER FM-07)", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "linear")
      .reply(200, okResponse({ category: "linear", list: [], nextPageCursor: "" }));
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ category: "spot", list: [], nextPageCursor: "" }));

    const client = new PublicExchangeClient({ testnet: true });
    const universe = await computeTradeableUniverse(client);

    expect(universe).toEqual([]);
  });
});
