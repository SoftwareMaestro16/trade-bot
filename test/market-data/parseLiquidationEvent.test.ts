import { describe, expect, it } from "vitest";
import { parseLiquidationEvent } from "../../src/market-data/parseLiquidationEvent.js";

describe("parseLiquidationEvent", () => {
  it("parses a real-shaped allLiquidation event into insertable rows", () => {
    const event = {
      topic: "allLiquidation.BTCUSDT",
      type: "snapshot",
      ts: 1785960000000,
      data: [{ T: 1785960000123, s: "BTCUSDT", S: "Sell", v: "0.123", p: "64725.5" }],
    };

    const rows = parseLiquidationEvent(event);

    expect(rows).toEqual([
      { symbol: "BTCUSDT", side: "Sell", size: "0.123", price: "64725.5", liquidation_time_ms: "1785960000123" },
    ]);
  });

  it("parses multiple liquidations in one event", () => {
    const event = {
      topic: "allLiquidation.ETHUSDT",
      type: "snapshot",
      ts: 1785960000000,
      data: [
        { T: 1785960000100, s: "ETHUSDT", S: "Buy", v: "1.0", p: "3200.1" },
        { T: 1785960000200, s: "ETHUSDT", S: "Sell", v: "2.5", p: "3199.8" },
      ],
    };

    expect(parseLiquidationEvent(event)).toHaveLength(2);
  });

  it("returns null for a non-liquidation topic (e.g. this WS connection also carries other topics)", () => {
    const event = { topic: "orderbook.50.BTCUSDT", type: "delta", ts: 1, data: {} };
    expect(parseLiquidationEvent(event)).toBeNull();
  });

  it("returns null for something that isn't a WS event at all", () => {
    expect(parseLiquidationEvent(null)).toBeNull();
    expect(parseLiquidationEvent(undefined)).toBeNull();
    expect(parseLiquidationEvent("not an event")).toBeNull();
    expect(parseLiquidationEvent({})).toBeNull();
  });

  it("skips malformed items within an otherwise-valid liquidation event rather than throwing", () => {
    const event = {
      topic: "allLiquidation.BTCUSDT",
      type: "snapshot",
      ts: 1,
      data: [
        { T: 1, s: "BTCUSDT", S: "Sell", v: "1", p: "1" }, // valid
        { T: 2, s: "BTCUSDT", S: "NotASide", v: "1", p: "1" }, // invalid side
        { s: "BTCUSDT", S: "Buy", v: "1", p: "1" }, // missing T
        null,
      ],
    };

    const rows = parseLiquidationEvent(event);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.liquidation_time_ms).toBe("1");
  });

  it("returns an empty array (not null) when data is present but empty", () => {
    const event = { topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: 1, data: [] };
    expect(parseLiquidationEvent(event)).toEqual([]);
  });
});
