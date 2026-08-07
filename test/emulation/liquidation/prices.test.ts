import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  computeBankruptcyPriceLong,
  computeBankruptcyPriceShort,
  computeDeltaNeutralPerpLegLiquidation,
  computeLiquidationPriceLong,
  computeLiquidationPriceShort,
  computeMaintenanceMargin,
} from "../../../src/emulation/liquidation/prices.js";
import type { MarginTier } from "../../../src/emulation/liquidation/marginTiers.js";
import { lookupMarginTier } from "../../../src/emulation/liquidation/marginTiers.js";

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
