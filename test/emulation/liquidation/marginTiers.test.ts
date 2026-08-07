import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_CONSERVATIVE_TIER,
  FETCHED_MARGIN_TIERS,
  KNOWN_MARGIN_TIERS,
  lookupMarginTier,
} from "../../../src/emulation/liquidation/marginTiers.js";
import type { MarginTier } from "../../../src/emulation/liquidation/marginTiers.js";

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
