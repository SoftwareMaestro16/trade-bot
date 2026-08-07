import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { refreshUniverse } from "../../src/collector/universe.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

afterEach(() => {
  nock.cleanAll();
});

// Mirrors test/market-data/universe.test.ts's own fixture shape — refreshUniverse
// is a thin wrapper around computeTradeableUniverse + assertUniverseNonEmpty,
// extracted verbatim out of collector.ts main()'s "universe-refresh"
// scheduleRepeating task body (see src/collector/universe.ts's own doc comment).
describe("refreshUniverse", () => {
  it("returns the freshly computed universe (FR-108 spot×perp intersection)", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "linear")
      .reply(
        200,
        okResponse({
          category: "linear",
          list: [
            { symbol: "BTCUSDT", contractType: "LinearPerpetual", status: "Trading", quoteCoin: "USDT", fundingInterval: 480 },
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
          list: [{ symbol: "BTCUSDT", status: "Trading", quoteCoin: "USDT" }],
          nextPageCursor: "",
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const universe = await refreshUniverse(client);

    expect(universe).toEqual([{ symbol: "BTCUSDT", fundingIntervalMinutes: 480 }]);
  });

  it("throws via assertUniverseNonEmpty instead of returning an empty universe (same guard as the inline version had)", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "linear")
      .reply(200, okResponse({ category: "linear", list: [], nextPageCursor: "" }));
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query((q) => q.category === "spot")
      .reply(200, okResponse({ category: "spot", list: [], nextPageCursor: "" }));

    const client = new PublicExchangeClient({ testnet: true });

    await expect(refreshUniverse(client)).rejects.toThrow(/computeTradeableUniverse returned 0 tradeable symbols/);
  });
});
