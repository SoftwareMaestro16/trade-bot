import Big from "big.js";
import { describe, expect, it } from "vitest";
import { computeCandidateYield, rankCandidates } from "../../src/strategy/rankCandidates.js";

describe("computeCandidateYield", () => {
  it("computes all three named fields (RSK-29), matching DECISIONS.md's own 0.02%/8h -> 21.9% APR worked example", () => {
    const result = computeCandidateYield(new Big("0.0002"), new Big("1000"), new Big("5000"));

    expect(result.yieldOnLegNotional.toString()).toBe("0.219");
    expect(result.yieldOnGrossNotional.toString()).toBe("0.1095");
    expect(result.yieldOnEquity.toString()).toBe("0.0438");
  });

  it("scales yieldOnEquity down as less of total equity is deployed into the leg", () => {
    const fullyDeployed = computeCandidateYield(new Big("0.0002"), new Big("5000"), new Big("5000"));
    const barelyDeployed = computeCandidateYield(new Big("0.0002"), new Big("100"), new Big("5000"));

    expect(fullyDeployed.yieldOnEquity.toString()).toBe("0.219"); // 100% deployed -> equals yieldOnLegNotional
    expect(Number(barelyDeployed.yieldOnEquity.toString())).toBeLessThan(Number(fullyDeployed.yieldOnEquity.toString()));
  });
});

describe("rankCandidates", () => {
  it("sorts descending by yieldOnEquity, not by yieldOnLegNotional or input order", () => {
    const a = { symbol: "A", yield: computeCandidateYield(new Big("0.0002"), new Big("1000"), new Big("5000")) }; // yieldOnEquity 0.0438
    const b = { symbol: "B", yield: computeCandidateYield(new Big("0.0005"), new Big("1000"), new Big("5000")) }; // yieldOnEquity 0.1095
    const c = { symbol: "C", yield: computeCandidateYield(new Big("0.0001"), new Big("1000"), new Big("5000")) }; // yieldOnEquity 0.0219

    const ranked = rankCandidates([a, b, c]);

    expect(ranked.map((r) => r.symbol)).toEqual(["B", "A", "C"]);
  });

  it("does not mutate the input array", () => {
    const a = { symbol: "A", yield: computeCandidateYield(new Big("0.0001"), new Big("1000"), new Big("5000")) };
    const b = { symbol: "B", yield: computeCandidateYield(new Big("0.0005"), new Big("1000"), new Big("5000")) };
    const input = [a, b];

    rankCandidates(input);

    expect(input).toEqual([a, b]); // original order untouched
  });

  it("returns an empty array for an empty input, not an error (a symbol-less cycle is a valid outcome, RISK-REGISTER.md FM-07)", () => {
    expect(rankCandidates([])).toEqual([]);
  });
});
