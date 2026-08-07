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

  it("throws Big.js's division-by-zero error when totalEquity is 0, rather than returning a silent NaN/Infinity-like value (this function has no zero-equity guard of its own — scenarioRunner.ts's targetNotional.lte(0) short-circuit is the caller's guard, not an invariant of this exported function)", () => {
    expect(() => computeCandidateYield(new Big("0.0002"), new Big("1000"), new Big("0"))).toThrow("[big.js] Division by zero");
  });

  it("still throws division-by-zero when legNotional is also 0 (0/0 is not special-cased to 0)", () => {
    expect(() => computeCandidateYield(new Big("0.0002"), new Big("0"), new Big("0"))).toThrow("[big.js] Division by zero");
  });

  it("flips all three fields negative for a negative funding rate, same magnitude as the positive worked example (RSK-29 sign correctness)", () => {
    // Exact negation of the DECISIONS.md 0.02%/8h -> 21.9% APR worked example above.
    const result = computeCandidateYield(new Big("-0.0002"), new Big("1000"), new Big("5000"));

    expect(result.yieldOnLegNotional.toString()).toBe("-0.219");
    expect(result.yieldOnGrossNotional.toString()).toBe("-0.1095");
    expect(result.yieldOnEquity.toString()).toBe("-0.0438");
  });

  it("keeps yieldOnLegNotional/yieldOnGrossNotional tied to the rate's sign, not equity's, when totalEquity is negative (underwater account)", () => {
    // Positive (profitable) rate, but the account itself is underwater (negative
    // total equity) — legNotional and rate are unaffected by equity's sign, so the
    // per-notional fields must stay positive; only yieldOnEquity, which divides by
    // totalEquity, should flip.
    const result = computeCandidateYield(new Big("0.0002"), new Big("1000"), new Big("-5000"));

    expect(result.yieldOnLegNotional.toString()).toBe("0.219");
    expect(result.yieldOnGrossNotional.toString()).toBe("0.1095");
    expect(result.yieldOnEquity.toString()).toBe("-0.0438");
  });

  it("BUG (RSK-29/FM-07): a negative rate on an underwater account cancels to a POSITIVE yieldOnEquity headline", () => {
    // This is the exact failure mode RSK-29's three-named-fields rule exists to
    // prevent: a losing funding rate (-0.0002, correctly negative on the first two
    // fields) combined with negative total equity divides two negatives into a
    // positive yieldOnEquity. A candidate that is actually losing money, on an
    // account that is actually underwater, would rank as if it had a *better*
    // yieldOnEquity than a genuinely profitable, solvent candidate (see the
    // rankCandidates test below). computeCandidateYield has no guard on
    // totalEquity's sign — unlike risk/leverage.ts's checkLeverage, which treats
    // totalEquity <= 0 as "cannot happen under correct business logic" and throws.
    // Documented here, not fixed: in the only current caller (scenarioRunner.ts)
    // this value is unreachable because checkLeverage already throws upstream on
    // the same totalEquity before rankCandidates ever runs, so this pins current
    // behavior for a future/direct caller rather than patching live behavior.
    const result = computeCandidateYield(new Big("-0.0002"), new Big("1000"), new Big("-5000"));

    expect(result.yieldOnLegNotional.toString()).toBe("-0.219");
    expect(result.yieldOnGrossNotional.toString()).toBe("-0.1095");
    expect(result.yieldOnEquity.toString()).toBe("0.0438"); // sign-inverted relative to the true (losing) rate
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

  it("ranks a positive-yield candidate above negative-yield ones, and orders the negatives correctly (least-negative first, not by absolute value)", () => {
    const positive = {
      symbol: "POS",
      yield: computeCandidateYield(new Big("0.0002"), new Big("1000"), new Big("5000")), // yieldOnEquity 0.0438
    };
    const slightlyNegative = {
      symbol: "SLIGHT_NEG",
      yield: computeCandidateYield(new Big("-0.0002"), new Big("1000"), new Big("5000")), // yieldOnEquity -0.0438
    };
    const veryNegative = {
      symbol: "VERY_NEG",
      yield: computeCandidateYield(new Big("-0.0005"), new Big("1000"), new Big("5000")), // yieldOnEquity -0.1095
    };

    // Deliberately unsorted input order so the assertion cannot pass by coincidence.
    const ranked = rankCandidates([veryNegative, positive, slightlyNegative]);

    expect(ranked.map((r) => r.symbol)).toEqual(["POS", "SLIGHT_NEG", "VERY_NEG"]);
  });
});
