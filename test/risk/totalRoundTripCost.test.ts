import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  computeTotalRoundTripCost,
  computeTotalRoundTripCostBreakdown,
} from "../../src/risk/totalRoundTripCost.js";
import type { TotalRoundTripCostInput } from "../../src/risk/totalRoundTripCost.js";
import { checkEntryThreshold } from "../../src/risk/economics.js";

/** VIP0 baseline, all other cost sources zeroed out — isolates the four fee legs. */
function vip0FeesOnlyInput(): TotalRoundTripCostInput {
  return {
    entrySpotFeeRate: new Big("0.001"), // 0.10%, VIP0 spot maker=taker
    entryPerpFeeRate: new Big("0.00055"), // 0.055%, VIP0 perp taker
    exitSpotFeeRate: new Big("0.001"),
    exitPerpFeeRate: new Big("0.00055"),
    expectedBasisDivergence: new Big("0"),
    entrySpotSlippageBp: new Big("0"),
    entryPerpSlippageBp: new Big("0"),
    exitSpotSlippageBp: new Big("0"),
    exitPerpSlippageBp: new Big("0"),
  };
}

describe("computeTotalRoundTripCost", () => {
  it("pins PARAMS-CONSERVATIVE.md §6 / TEST-CASES.md #49's own C_total=0.0031 VIP0 baseline (4 fee legs, no basis, no slippage)", () => {
    const cost = computeTotalRoundTripCost(vip0FeesOnlyInput());
    expect(cost.toString()).toBe("0.0031");
  });

  it("adds expected basis divergence on top of the fee legs", () => {
    const cost = computeTotalRoundTripCost({
      ...vip0FeesOnlyInput(),
      expectedBasisDivergence: new Big("0.001"),
    });
    expect(cost.toString()).toBe("0.0041");
  });

  it("adds all four slippage legs on top of fees and basis", () => {
    const cost = computeTotalRoundTripCost({
      ...vip0FeesOnlyInput(),
      entrySpotSlippageBp: new Big("0.0002"),
      entryPerpSlippageBp: new Big("0.0001"),
      exitSpotSlippageBp: new Big("0.0003"),
      exitPerpSlippageBp: new Big("0.0001"),
    });
    // 0.0031 fees + 0.0007 slippage
    expect(cost.toString()).toBe("0.0038");
  });

  it("is exactly zero when every component is zero", () => {
    const cost = computeTotalRoundTripCost({
      entrySpotFeeRate: new Big("0"),
      entryPerpFeeRate: new Big("0"),
      exitSpotFeeRate: new Big("0"),
      exitPerpFeeRate: new Big("0"),
      expectedBasisDivergence: new Big("0"),
      entrySpotSlippageBp: new Big("0"),
      entryPerpSlippageBp: new Big("0"),
      exitSpotSlippageBp: new Big("0"),
      exitPerpSlippageBp: new Big("0"),
    });
    expect(cost.toString()).toBe("0");
  });

  it("entry and exit fee legs are independent — a mid-hold VIP-tier change on one side alone is not silently doubled or dropped", () => {
    const cost = computeTotalRoundTripCost({
      ...vip0FeesOnlyInput(),
      exitSpotFeeRate: new Big("0.0006"), // upgraded VIP tier by exit time, e.g.
      exitPerpFeeRate: new Big("0.0002"),
    });
    // entry: 0.001 + 0.00055 = 0.00155; exit: 0.0006 + 0.0002 = 0.0008
    expect(cost.toString()).toBe("0.00235");
  });

  it("entry and exit slippage legs are independent — RISK-REGISTER.md FM-03's 'exit book is systematically worse' case is representable, not collapsed to one shared figure", () => {
    const cost = computeTotalRoundTripCost({
      ...vip0FeesOnlyInput(),
      entrySpotSlippageBp: new Big("0.0001"),
      entryPerpSlippageBp: new Big("0.0001"),
      exitSpotSlippageBp: new Big("0.0009"), // exit book much thinner than entry
      exitPerpSlippageBp: new Big("0.0002"),
    });
    // 0.0031 fees + 0.0013 slippage
    expect(cost.toString()).toBe("0.0044");
  });
});

describe("computeTotalRoundTripCostBreakdown", () => {
  it("groups fees, basis, and slippage into the three FR-202-required categories, summing to the same total computeTotalRoundTripCost returns", () => {
    const input: TotalRoundTripCostInput = {
      ...vip0FeesOnlyInput(),
      expectedBasisDivergence: new Big("0.0005"),
      entrySpotSlippageBp: new Big("0.0001"),
      entryPerpSlippageBp: new Big("0.0001"),
      exitSpotSlippageBp: new Big("0.0001"),
      exitPerpSlippageBp: new Big("0.0001"),
    };

    const breakdown = computeTotalRoundTripCostBreakdown(input);
    const directTotal = computeTotalRoundTripCost(input);

    expect(breakdown.feesComponent.toString()).toBe("0.0031");
    expect(breakdown.basisComponent.toString()).toBe("0.0005");
    expect(breakdown.slippageComponent.toString()).toBe("0.0004");
    expect(breakdown.total.toString()).toBe(directTotal.toString());
    expect(breakdown.total.toString()).toBe("0.004");
  });

  it("basisComponent is exactly the expectedBasisDivergence input, unmodified", () => {
    const breakdown = computeTotalRoundTripCostBreakdown({
      ...vip0FeesOnlyInput(),
      expectedBasisDivergence: new Big("0.0025"),
    });
    expect(breakdown.basisComponent.toString()).toBe("0.0025");
  });
});

/**
 * Proves computeTotalRoundTripCost's output is actually unit-compatible with
 * risk/economics.ts's checkEntryThreshold — both must agree that this value
 * is a signed-positive FRACTION OF NOTIONAL, comparable against
 * `r8h × expectedHoldIntervals` after the K=2.0 multiplier (RR-24,
 * RISK-REGISTER.md FM-01), not an absolute currency amount. This is the
 * actual composition risk/index.ts's EntryCheckInput.totalRoundTripCost
 * field is for.
 */
describe("computeTotalRoundTripCost feeding directly into checkEntryThreshold (RR-24)", () => {
  it("allows when expected gross clears K=2.0x the computed round-trip cost", () => {
    const totalRoundTripCost = computeTotalRoundTripCost(vip0FeesOnlyInput()); // 0.0031
    // r8h=0.001, 13 intervals -> expectedGross=0.013; required=2.0*0.0031=0.0062. 0.013 >= 0.0062.
    const result = checkEntryThreshold(new Big("0.001"), new Big("13"), totalRoundTripCost);
    expect(result.allowed).toBe(true);
  });

  it("denies when expected gross falls below K=2.0x the computed round-trip cost, using the SAME cost figure", () => {
    const totalRoundTripCost = computeTotalRoundTripCost(vip0FeesOnlyInput()); // 0.0031
    // r8h=0.001, 3 intervals -> expectedGross=0.003; required=2.0*0.0031=0.0062. 0.003 < 0.0062.
    const result = checkEntryThreshold(new Big("0.001"), new Big("3"), totalRoundTripCost);
    expect(result).toMatchObject({ allowed: false, code: "EXPECTED_GROSS_TOO_LOW" });
  });

  it("adding realistic basis divergence and slippage on top of the VIP0 fee baseline raises the bar checkEntryThreshold enforces", () => {
    const cheapCost = computeTotalRoundTripCost(vip0FeesOnlyInput()); // 0.0031
    const realisticCost = computeTotalRoundTripCost({
      ...vip0FeesOnlyInput(),
      expectedBasisDivergence: new Big("0.001"),
      entrySpotSlippageBp: new Big("0.0002"),
      entryPerpSlippageBp: new Big("0.0002"),
      exitSpotSlippageBp: new Big("0.0002"),
      exitPerpSlippageBp: new Big("0.0002"),
    }); // 0.0031 + 0.001 + 0.0008 = 0.0049

    // Same r8h/intervals clear the cheap-cost requirement but not the realistic one.
    const r8h = new Big("0.001");
    const expectedHoldIntervals = new Big("13"); // expectedGross = 0.013

    expect(checkEntryThreshold(r8h, expectedHoldIntervals, cheapCost).allowed).toBe(true);
    // required for realisticCost = 2.0 * 0.0049 = 0.0098; 0.013 >= 0.0098 still allows here,
    // so tighten the hold window to actually cross the boundary this raised cost creates.
    const tighterIntervals = new Big("9"); // expectedGross = 0.009 < 0.0098
    expect(checkEntryThreshold(r8h, tighterIntervals, cheapCost).allowed).toBe(true); // 0.009 >= 2*0.0031=0.0062
    expect(checkEntryThreshold(r8h, tighterIntervals, realisticCost).allowed).toBe(false); // 0.009 < 0.0098
  });
});
