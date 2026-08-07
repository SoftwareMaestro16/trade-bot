import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  simulateDeltaNeutralForcedLiquidation,
  simulateForcedLiquidation,
} from "../../../src/emulation/liquidation/simulate.js";
import type { MarkPriceTick } from "../../../src/emulation/liquidation/simulate.js";
import { computeDeltaNeutralPerpLegLiquidation } from "../../../src/emulation/liquidation/prices.js";
import { lookupMarginTier } from "../../../src/emulation/liquidation/marginTiers.js";

describe("simulateForcedLiquidation", () => {
  const liquidationPrice = new Big("110");

  function tick(timestampMs: number, markPrice: string): MarkPriceTick {
    return { timestampMs, markPrice: new Big(markPrice) };
  }

  it("returns wasLiquidated=false for an empty tick series", () => {
    const result = simulateForcedLiquidation([], liquidationPrice, "short");
    expect(result.wasLiquidated).toBe(false);
    expect(result.liquidationTick).toBeUndefined();
  });

  it("short: never liquidated when price stays below the liquidation price throughout", () => {
    const ticks = [tick(1, "100"), tick(2, "105"), tick(3, "109.99")];
    const result = simulateForcedLiquidation(ticks, liquidationPrice, "short");
    expect(result.wasLiquidated).toBe(false);
  });

  it("short: liquidated exactly when price reaches the liquidation price — boundary is inclusive ('hits', source 1)", () => {
    const ticks = [tick(1, "100"), tick(2, "110")];
    const result = simulateForcedLiquidation(ticks, liquidationPrice, "short");
    expect(result.wasLiquidated).toBe(true);
    expect(result.liquidationTickIndex).toBe(1);
    expect(result.liquidationTick?.markPrice.toString()).toBe("110");
  });

  it("short: reports the FIRST crossing, not a later one, even if price falls back afterward", () => {
    const ticks = [tick(1, "100"), tick(2, "111"), tick(3, "95"), tick(4, "150")];
    const result = simulateForcedLiquidation(ticks, liquidationPrice, "short");
    expect(result.wasLiquidated).toBe(true);
    expect(result.liquidationTickIndex).toBe(1);
    expect(result.liquidationTick?.markPrice.toString()).toBe("111");
  });

  it("long: liquidated when price falls to/below the liquidation price (mirror direction of short)", () => {
    const longLiquidationPrice = new Big("90");
    const ticks = [tick(1, "100"), tick(2, "95"), tick(3, "89")];
    const result = simulateForcedLiquidation(ticks, longLiquidationPrice, "long");
    expect(result.wasLiquidated).toBe(true);
    expect(result.liquidationTickIndex).toBe(2);
  });

  it("long: never liquidated when price stays above the liquidation price throughout", () => {
    const longLiquidationPrice = new Big("90");
    const ticks = [tick(1, "100"), tick(2, "95"), tick(3, "91")];
    const result = simulateForcedLiquidation(ticks, longLiquidationPrice, "long");
    expect(result.wasLiquidated).toBe(false);
  });

  it("throws RangeError when ticks are not sorted ascending by timestampMs", () => {
    const ticks = [tick(2, "100"), tick(1, "105")];
    expect(() => simulateForcedLiquidation(ticks, liquidationPrice, "short")).toThrow(RangeError);
  });

  it("does not throw for ticks with equal (non-decreasing) consecutive timestamps", () => {
    const ticks = [tick(1, "100"), tick(1, "101"), tick(2, "111")];
    const result = simulateForcedLiquidation(ticks, liquidationPrice, "short");
    expect(result.wasLiquidated).toBe(true);
    expect(result.liquidationTickIndex).toBe(2);
  });
});

describe("simulateDeltaNeutralForcedLiquidation", () => {
  const tier = lookupMarginTier("BTCUSDT", new Big("40000"));
  const input = {
    perpEntryPrice: new Big("40000"),
    qty: new Big("1"),
    leverage: new Big("50"),
    tier,
    takerFeeRate: new Big("0.00055"),
  };

  function tick(timestampMs: number, markPrice: string): MarkPriceTick {
    return { timestampMs, markPrice: new Big(markPrice) };
  }

  it("returns the same perpLiquidationPrice computeDeltaNeutralPerpLegLiquidation would, alongside the simulation result", () => {
    const expected = computeDeltaNeutralPerpLegLiquidation(input).perpLiquidationPrice;
    const result = simulateDeltaNeutralForcedLiquidation([tick(1, "40000")], input);
    expect(result.perpLiquidationPrice.toString()).toBe(expected.toString());
  });

  it("flags liquidation once the mark price series rises through the perp leg's liquidation price", () => {
    const { perpLiquidationPrice } = computeDeltaNeutralPerpLegLiquidation(input);
    const crossingPrice = perpLiquidationPrice.plus(1).toString();
    const ticks = [tick(1, "40000"), tick(2, "40500"), tick(3, crossingPrice)];
    const result = simulateDeltaNeutralForcedLiquidation(ticks, input);
    expect(result.wasLiquidated).toBe(true);
    expect(result.liquidationTickIndex).toBe(2);
  });

  it("reports no liquidation when the mark price series never approaches the perp leg's liquidation price", () => {
    const ticks = [tick(1, "40000"), tick(2, "40100"), tick(3, "39900")];
    const result = simulateDeltaNeutralForcedLiquidation(ticks, input);
    expect(result.wasLiquidated).toBe(false);
  });
});
