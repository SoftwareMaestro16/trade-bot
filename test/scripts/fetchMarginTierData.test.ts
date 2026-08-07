import { describe, expect, it } from "vitest";
import { computeTierRanks } from "../../src/scripts/fetchMarginTierData.js";
import type { UntieredRow } from "../../src/scripts/fetchMarginTierData.js";

function row(riskLimitValue: string): UntieredRow {
  return {
    riskLimitValue,
    maintenanceMarginRate: "0.005",
    initialMarginRate: "0.01",
    maxLeverage: "100",
    mmDeduction: "0",
    source: "bybit-api-snapshot",
  };
}

describe("computeTierRanks", () => {
  it("assigns 1-based tier ranks in ascending riskLimitValue order", () => {
    const ranked = computeTierRanks([row("9000000"), row("2000000"), row("35000000")]);
    expect(ranked.map((r) => [r.tier, r.riskLimitValue])).toEqual([
      [1, "2000000"],
      [2, "9000000"],
      [3, "35000000"],
    ]);
  });

  it("sorts NUMERICALLY, not lexicographically — the exact real bug this function exists to prevent (a naive string sort would put '9000000' before '35000000')", () => {
    const ranked = computeTierRanks([row("35000000"), row("9000000")]);
    expect(ranked.map((r) => r.riskLimitValue)).toEqual(["9000000", "35000000"]);
  });

  it("does not trust any incoming order or id — rank is derived purely from riskLimitValue, matching the real ADAUSDT case where the wire's global id (116) was not a per-symbol rank", () => {
    // Simulates rows arriving in a globally-numbered, not per-symbol-ranked,
    // order — exactly what the module's own doc comment says Bybit's raw
    // `id` field actually is (a global counter, not a rank).
    const ranked = computeTierRanks([row("50000000"), row("1000000"), row("10000000")]);
    expect(ranked.map((r) => r.tier)).toEqual([1, 2, 3]);
    expect(ranked.map((r) => r.riskLimitValue)).toEqual(["1000000", "10000000", "50000000"]);
  });

  it("preserves every other field unchanged, only adding tier", () => {
    const input = row("5000000");
    const [ranked] = computeTierRanks([input]);
    expect(ranked).toEqual({ tier: 1, ...input });
  });

  it("handles a single-row ladder", () => {
    expect(computeTierRanks([row("1000000")])).toEqual([{ tier: 1, ...row("1000000") }]);
  });

  it("handles an empty ladder", () => {
    expect(computeTierRanks([])).toEqual([]);
  });

  it("does not mutate the input array (returns a new sorted array)", () => {
    const input = [row("9000000"), row("2000000")];
    const inputCopy = [...input];
    computeTierRanks(input);
    expect(input).toEqual(inputCopy);
  });
});
