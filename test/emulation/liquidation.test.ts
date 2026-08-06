import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  computeBankruptcyPriceLong,
  computeBankruptcyPriceShort,
  computeDeltaNeutralPerpLegLiquidation,
  computeLiquidationPriceLong,
  computeLiquidationPriceShort,
  computeMaintenanceMargin,
  FALLBACK_CONSERVATIVE_TIER,
  FETCHED_MARGIN_TIERS,
  KNOWN_MARGIN_TIERS,
  lookupMarginTier,
  simulateDeltaNeutralForcedLiquidation,
  simulateForcedLiquidation,
} from "../../src/emulation/liquidation.js";
import type { MarginTier, MarkPriceTick } from "../../src/emulation/liquidation.js";

/** Builds a custom MarginTier for tests that need a specific MMR/IMR/mmDeduction not present in KNOWN_MARGIN_TIERS's real data (e.g. a clean MMR=0 edge case). */
function mkTier(overrides: Partial<Record<keyof MarginTier, string | number>> = {}): MarginTier {
  return {
    tier: Number(overrides.tier ?? 1),
    riskLimitValue: new Big(overrides.riskLimitValue ?? "1000000000"),
    maintenanceMarginRate: new Big(overrides.maintenanceMarginRate ?? "0"),
    initialMarginRate: new Big(overrides.initialMarginRate ?? "0"),
    maxLeverage: new Big(overrides.maxLeverage ?? "100"),
    mmDeduction: new Big(overrides.mmDeduction ?? "0"),
    source: "conservative-placeholder",
  };
}

describe("lookupMarginTier", () => {
  it("returns BTCUSDT tier 1 for a small position notional", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("1000"));
    expect(tier.tier).toBe(1);
    expect(tier.maintenanceMarginRate.toString()).toBe("0.005");
    expect(tier.initialMarginRate.toString()).toBe("0.01");
    expect(tier.source).toBe("bybit-api-snapshot");
  });

  it("boundary: exactly at BTCUSDT tier 1's riskLimitValue (2,000,000) is still tier 1 — source 4's 'or below' wording is inclusive", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("2000000"));
    expect(tier.tier).toBe(1);
  });

  it("boundary: one unit above BTCUSDT tier 1's riskLimitValue moves to tier 2", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("2000000.01"));
    expect(tier.tier).toBe(2);
  });

  it("matches source 4's own worked example exactly: 2,600,000 USDT BTCUSDT position -> 0.56% MMR", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("2600000"));
    expect(tier.tier).toBe(2);
    expect(tier.maintenanceMarginRate.toString()).toBe("0.0056");
  });

  it("returns ADAUSDT tier 1 for a small position notional, distinct from BTCUSDT's tier 1", () => {
    const tier = lookupMarginTier("ADAUSDT", new Big("1000"));
    expect(tier.tier).toBe(1);
    expect(tier.maintenanceMarginRate.toString()).toBe("0.0075");
    expect(tier.initialMarginRate.toString()).toBe("0.0133");
  });

  it("falls back to FALLBACK_CONSERVATIVE_TIER for a symbol not in the table, rather than throwing", () => {
    const tier = lookupMarginTier("SHIBUSDT", new Big("1000"));
    expect(tier).toBe(FALLBACK_CONSERVATIVE_TIER);
    expect(tier.source).toBe("conservative-placeholder");
  });

  it("the fallback tier's MMR is strictly worse (higher) than both real verified symbols' own tier 1 — never silently optimistic for an unverified symbol", () => {
    const btcTier1 = lookupMarginTier("BTCUSDT", new Big("1000"));
    const adaTier1 = lookupMarginTier("ADAUSDT", new Big("1000"));
    expect(FALLBACK_CONSERVATIVE_TIER.maintenanceMarginRate.gt(btcTier1.maintenanceMarginRate)).toBe(true);
    expect(FALLBACK_CONSERVATIVE_TIER.maintenanceMarginRate.gt(adaTier1.maintenanceMarginRate)).toBe(true);
  });

  it("clamps to the highest tier when position notional exceeds every bracket in the symbol's table, rather than throwing or extrapolating", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("999999999999"));
    expect(tier.tier).toBe(35);
    expect(tier.riskLimitValue.toString()).toBe("1200000000");
  });

  it("throws RangeError for zero positionNotional — not a real position", () => {
    expect(() => lookupMarginTier("BTCUSDT", new Big("0"))).toThrow(RangeError);
  });

  it("throws RangeError for negative positionNotional", () => {
    expect(() => lookupMarginTier("BTCUSDT", new Big("-1"))).toThrow(RangeError);
  });

  it("accepts an explicit custom table instead of the default KNOWN_MARGIN_TIERS", () => {
    const customTier = mkTier({ maintenanceMarginRate: "0.099", tier: 7 });
    const table = { CUSTOMUSDT: [customTier] };
    const result = lookupMarginTier("CUSTOMUSDT", new Big("1"), table);
    expect(result).toBe(customTier);
  });

  it("KNOWN_MARGIN_TIERS exposes exactly the two verified symbols, each with its full real tier ladder length", () => {
    expect(Object.keys(KNOWN_MARGIN_TIERS).sort()).toEqual(["ADAUSDT", "BTCUSDT"]);
    expect(KNOWN_MARGIN_TIERS.BTCUSDT).toHaveLength(35);
    expect(KNOWN_MARGIN_TIERS.ADAUSDT).toHaveLength(30);
  });

  // AAVEUSDT is real, full-universe data present ONLY in FETCHED_MARGIN_TIERS
  // (marginTierData.json) — it is not, and must not become, one of
  // KNOWN_MARGIN_TIERS's two hand-verified symbols. These cases exist
  // specifically to prove lookupMarginTier's default call site (no explicit
  // `table` argument) actually reaches the FETCHED_MARGIN_TIERS layer, not
  // just KNOWN_MARGIN_TIERS.
  it("AAVEUSDT is not one of the hand-verified KNOWN_MARGIN_TIERS symbols (sanity precondition for the FETCHED_MARGIN_TIERS tests below)", () => {
    expect(Object.keys(KNOWN_MARGIN_TIERS)).not.toContain("AAVEUSDT");
    expect(Object.keys(FETCHED_MARGIN_TIERS)).toContain("AAVEUSDT");
  });

  it("resolves AAVEUSDT tier 1 from FETCHED_MARGIN_TIERS (marginTierData.json), a symbol absent from KNOWN_MARGIN_TIERS", () => {
    const tier = lookupMarginTier("AAVEUSDT", new Big("1000"));
    expect(tier.tier).toBe(1);
    expect(tier.maintenanceMarginRate.toString()).toBe("0.0075");
    expect(tier.initialMarginRate.toString()).toBe("0.0133");
    expect(tier.source).toBe("bybit-api-snapshot");
  });

  it("boundary: exactly at AAVEUSDT tier 1's riskLimitValue (200,000) is still tier 1; one unit above moves to tier 2's MMR from FETCHED_MARGIN_TIERS", () => {
    const atBoundary = lookupMarginTier("AAVEUSDT", new Big("200000"));
    expect(atBoundary.tier).toBe(1);
    expect(atBoundary.maintenanceMarginRate.toString()).toBe("0.0075");

    const aboveBoundary = lookupMarginTier("AAVEUSDT", new Big("200000.01"));
    expect(aboveBoundary.tier).toBe(2);
    expect(aboveBoundary.maintenanceMarginRate.toString()).toBe("0.01");
  });

  it("clamps AAVEUSDT to its highest FETCHED_MARGIN_TIERS tier when notional exceeds every bracket, same clamping behavior as the hardcoded tables", () => {
    const tier = lookupMarginTier("AAVEUSDT", new Big("999999999999"));
    expect(tier.tier).toBe(30);
    expect(tier.riskLimitValue.toString()).toBe("35000000");
  });

  it("still falls back to FALLBACK_CONSERVATIVE_TIER for a symbol present in neither KNOWN_MARGIN_TIERS nor FETCHED_MARGIN_TIERS", () => {
    const fakeSymbol = "NOTAREALSYMBOLUSDT";
    expect(Object.keys(KNOWN_MARGIN_TIERS)).not.toContain(fakeSymbol);
    expect(Object.keys(FETCHED_MARGIN_TIERS)).not.toContain(fakeSymbol);

    const tier = lookupMarginTier(fakeSymbol, new Big("1000"));
    expect(tier).toBe(FALLBACK_CONSERVATIVE_TIER);
    expect(tier.source).toBe("conservative-placeholder");
  });
});

describe("computeMaintenanceMargin", () => {
  it("matches source 1's own fully worked example exactly: 40,000 USDT position, 0.5% MMR, 0 deduction, 21.56 fee to close -> 221.56", () => {
    const tier = mkTier({ maintenanceMarginRate: "0.005", mmDeduction: "0" });
    const mm = computeMaintenanceMargin(new Big("40000"), tier, new Big("21.56"));
    expect(mm.toString()).toBe("221.56");
  });

  it("subtracts a nonzero mmDeduction, per source 1's explicit formula term", () => {
    const tier = mkTier({ maintenanceMarginRate: "0.01", mmDeduction: "50" });
    const mm = computeMaintenanceMargin(new Big("10000"), tier);
    // 10000*0.01 - 50 + 0 = 100 - 50 = 50
    expect(mm.toString()).toBe("50");
  });

  it("feeToClose defaults to zero when omitted", () => {
    const tier = mkTier({ maintenanceMarginRate: "0.02", mmDeduction: "0" });
    const mm = computeMaintenanceMargin(new Big("1000"), tier);
    expect(mm.toString()).toBe("20");
  });
});

describe("computeBankruptcyPriceLong / computeBankruptcyPriceShort", () => {
  it("matches source 2's own fully worked example exactly: BTCUSDT long, 60,000 USDT entry, 50x leverage -> 58,800 USDT", () => {
    const bp = computeBankruptcyPriceLong(new Big("60000"), new Big("50"));
    expect(bp.toString()).toBe("58800");
  });

  it("short is the exact algebraic mirror of the long formula (1 + IMR instead of 1 - IMR) at the same inputs", () => {
    const bp = computeBankruptcyPriceShort(new Big("60000"), new Big("50"));
    // 60000 * (1 + 1/50) = 60000 * 1.02 = 61200
    expect(bp.toString()).toBe("61200");
  });

  it("long and short bankruptcy prices are equidistant from entry price at the same leverage (symmetric by construction)", () => {
    const entry = new Big("2000");
    const leverage = new Big("25");
    const longBp = computeBankruptcyPriceLong(entry, leverage);
    const shortBp = computeBankruptcyPriceShort(entry, leverage);
    expect(entry.minus(longBp).toString()).toBe(shortBp.minus(entry).toString());
  });

  it("throws RangeError when leverage is zero (long)", () => {
    expect(() => computeBankruptcyPriceLong(new Big("100"), new Big("0"))).toThrow(RangeError);
  });

  it("throws RangeError when leverage is negative (short)", () => {
    expect(() => computeBankruptcyPriceShort(new Big("100"), new Big("-5"))).toThrow(RangeError);
  });
});

describe("computeLiquidationPriceLong", () => {
  it("matches source 1's own fully worked example within $0.01: 1 BTC long @ 40,000 USDT, 50x, 3,000 USDT extra margin, 0.5% MMR, 0.055% taker fee, 0 mmDeduction -> 36,380.25 USDT", () => {
    const tier = mkTier({ maintenanceMarginRate: "0.005", mmDeduction: "0" });
    const lp = computeLiquidationPriceLong({
      entryPrice: new Big("40000"),
      qty: new Big("1"),
      leverage: new Big("50"),
      tier,
      takerFeeRate: new Big("0.00055"),
      extraMarginAdded: new Big("3000"),
    });
    expect(lp.minus(new Big("36380.25")).abs().lt(new Big("0.01"))).toBe(true);
  });

  it("clean edge case (MMRate=0, no extra margin, no deduction): reduces to entryPrice - entryPrice/leverage exactly", () => {
    const tier = mkTier({ maintenanceMarginRate: "0", mmDeduction: "0" });
    const lp = computeLiquidationPriceLong({
      entryPrice: new Big("100"),
      qty: new Big("10"),
      leverage: new Big("10"),
      tier,
      takerFeeRate: new Big("0.001"),
    });
    // [100*10 - 100*10/10 - 0 - 0] / [10 - 0] = [1000-100]/10 = 90
    expect(lp.toString()).toBe("90");
  });

  it("extraMarginAdded defaults to 0 when omitted, matching an explicit 0", () => {
    const tier = mkTier({ maintenanceMarginRate: "0.01", mmDeduction: "0" });
    const withDefault = computeLiquidationPriceLong({
      entryPrice: new Big("500"),
      qty: new Big("2"),
      leverage: new Big("5"),
      tier,
      takerFeeRate: new Big("0.0005"),
    });
    const withExplicitZero = computeLiquidationPriceLong({
      entryPrice: new Big("500"),
      qty: new Big("2"),
      leverage: new Big("5"),
      tier,
      takerFeeRate: new Big("0.0005"),
      extraMarginAdded: new Big("0"),
    });
    expect(withDefault.toString()).toBe(withExplicitZero.toString());
  });

  it("takerFeeRate has zero effect on the result when extraMarginAdded is 0 (the fee term only scales extra margin) — an arbitrarily large fee rate changes nothing", () => {
    const tier = mkTier({ maintenanceMarginRate: "0.01", mmDeduction: "0" });
    const lowFee = computeLiquidationPriceLong({
      entryPrice: new Big("1000"),
      qty: new Big("1"),
      leverage: new Big("10"),
      tier,
      takerFeeRate: new Big("0.0001"),
    });
    const highFee = computeLiquidationPriceLong({
      entryPrice: new Big("1000"),
      qty: new Big("1"),
      leverage: new Big("10"),
      tier,
      takerFeeRate: new Big("0.5"),
    });
    expect(lowFee.toString()).toBe(highFee.toString());
  });

  it("throws RangeError when qty is zero", () => {
    const tier = mkTier();
    expect(() =>
      computeLiquidationPriceLong({
        entryPrice: new Big("100"),
        qty: new Big("0"),
        leverage: new Big("10"),
        tier,
        takerFeeRate: new Big("0.001"),
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when leverage is negative", () => {
    const tier = mkTier();
    expect(() =>
      computeLiquidationPriceLong({
        entryPrice: new Big("100"),
        qty: new Big("1"),
        leverage: new Big("-10"),
        tier,
        takerFeeRate: new Big("0.001"),
      }),
    ).toThrow(RangeError);
  });

  it("liquidation price sits below entry price for a realistic long (BTCUSDT tier 1, no extra margin)", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("40000"));
    const lp = computeLiquidationPriceLong({
      entryPrice: new Big("40000"),
      qty: new Big("1"),
      leverage: new Big("50"),
      tier,
      takerFeeRate: new Big("0.00055"),
    });
    expect(lp.lt(new Big("40000"))).toBe(true);
  });
});

describe("computeLiquidationPriceShort", () => {
  it("clean edge case (MMRate=0, no extra margin, no deduction): reduces to entryPrice + entryPrice/leverage exactly — the mirror of the long-side clean case (90 vs 110 at identical inputs)", () => {
    const tier = mkTier({ maintenanceMarginRate: "0", mmDeduction: "0" });
    const lp = computeLiquidationPriceShort({
      entryPrice: new Big("100"),
      qty: new Big("10"),
      leverage: new Big("10"),
      tier,
      takerFeeRate: new Big("0.001"),
    });
    // [100*10 + 100*10/10 + 0 + 0] / [10 + 0] = [1000+100]/10 = 110
    expect(lp.toString()).toBe("110");
  });

  it("extraMarginAdded and mmDeduction both push the short liquidation price further from entry (more room before liquidation)", () => {
    const tierNoDeduction = mkTier({ maintenanceMarginRate: "0", mmDeduction: "0" });
    const tierWithDeduction = mkTier({ maintenanceMarginRate: "0", mmDeduction: "5" });
    const base = computeLiquidationPriceShort({
      entryPrice: new Big("100"),
      qty: new Big("10"),
      leverage: new Big("10"),
      tier: tierNoDeduction,
      takerFeeRate: new Big("0"),
    });
    const withDeduction = computeLiquidationPriceShort({
      entryPrice: new Big("100"),
      qty: new Big("10"),
      leverage: new Big("10"),
      tier: tierWithDeduction,
      takerFeeRate: new Big("0"),
    });
    const withExtraMargin = computeLiquidationPriceShort({
      entryPrice: new Big("100"),
      qty: new Big("10"),
      leverage: new Big("10"),
      tier: tierNoDeduction,
      takerFeeRate: new Big("0"),
      extraMarginAdded: new Big("50"),
    });
    // base = 110; mmDeduction=5 adds 5/qty(10) = 0.5 -> 110.5
    expect(withDeduction.toString()).toBe("110.5");
    // extraMargin=50, fee=0 -> +50/10 = +5 -> 115
    expect(withExtraMargin.toString()).toBe("115");
    expect(withDeduction.gt(base)).toBe(true);
    expect(withExtraMargin.gt(base)).toBe(true);
  });

  it("throws RangeError when qty is negative", () => {
    const tier = mkTier();
    expect(() =>
      computeLiquidationPriceShort({
        entryPrice: new Big("100"),
        qty: new Big("-1"),
        leverage: new Big("10"),
        tier,
        takerFeeRate: new Big("0.001"),
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when leverage is zero", () => {
    const tier = mkTier();
    expect(() =>
      computeLiquidationPriceShort({
        entryPrice: new Big("100"),
        qty: new Big("1"),
        leverage: new Big("0"),
        tier,
        takerFeeRate: new Big("0.001"),
      }),
    ).toThrow(RangeError);
  });

  it("liquidation price sits above entry price for a realistic short (BTCUSDT tier 1, no extra margin) — the delta-neutral perp leg's actual direction", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("40000"));
    const lp = computeLiquidationPriceShort({
      entryPrice: new Big("40000"),
      qty: new Big("1"),
      leverage: new Big("50"),
      tier,
      takerFeeRate: new Big("0.00055"),
    });
    expect(lp.gt(new Big("40000"))).toBe(true);
  });

  it("bankruptcy price sits strictly beyond the liquidation price (further above entry) for a realistic short — IMR > MMR at every real tier, so full margin depletion is a bigger move than the maintenance-margin trigger", () => {
    const tier = lookupMarginTier("BTCUSDT", new Big("40000")); // tier 1: MMR 0.5%, IMR 1%
    const entryPrice = new Big("40000");
    const leverage = new Big("50");
    const lp = computeLiquidationPriceShort({
      entryPrice,
      qty: new Big("1"),
      leverage,
      tier,
      takerFeeRate: new Big("0.00055"),
    });
    const bp = computeBankruptcyPriceShort(entryPrice, leverage);
    expect(bp.gt(lp)).toBe(true);
  });
});

describe("computeDeltaNeutralPerpLegLiquidation", () => {
  const tier = lookupMarginTier("BTCUSDT", new Big("40000"));
  const baseInput = {
    perpEntryPrice: new Big("40000"),
    qty: new Big("1"),
    leverage: new Big("50"),
    tier,
    takerFeeRate: new Big("0.00055"),
  };

  it("delegates perpLiquidationPrice to computeLiquidationPriceShort with the same inputs", () => {
    const result = computeDeltaNeutralPerpLegLiquidation(baseInput);
    const direct = computeLiquidationPriceShort({
      entryPrice: baseInput.perpEntryPrice,
      qty: baseInput.qty,
      leverage: baseInput.leverage,
      tier: baseInput.tier,
      takerFeeRate: baseInput.takerFeeRate,
    });
    expect(result.perpLiquidationPrice.toString()).toBe(direct.toString());
  });

  it("delegates perpBankruptcyPrice to computeBankruptcyPriceShort with the same inputs", () => {
    const result = computeDeltaNeutralPerpLegLiquidation(baseInput);
    const direct = computeBankruptcyPriceShort(baseInput.perpEntryPrice, baseInput.leverage);
    expect(result.perpBankruptcyPrice.toString()).toBe(direct.toString());
  });

  it("spotLegCanBeLiquidated is always false — the spot leg (bought outright with cash, RR-25a) has no liquidation mechanism of its own", () => {
    const result = computeDeltaNeutralPerpLegLiquidation(baseInput);
    expect(result.spotLegCanBeLiquidated).toBe(false);
  });

  it("passes extraMarginAdded through to the underlying liquidation price calculation", () => {
    const withExtra = computeDeltaNeutralPerpLegLiquidation({ ...baseInput, extraMarginAdded: new Big("1000") });
    const withoutExtra = computeDeltaNeutralPerpLegLiquidation(baseInput);
    expect(withExtra.perpLiquidationPrice.toString()).not.toBe(withoutExtra.perpLiquidationPrice.toString());
  });
});

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
