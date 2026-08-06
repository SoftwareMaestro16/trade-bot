import Big from "big.js";
import { describe, expect, it } from "vitest";
import { checkDrawdown, computeDrawdown } from "../../src/risk/drawdown.js";

describe("computeDrawdown", () => {
  it("computes the fraction drawn down from peak (RR-40)", () => {
    const drawdown = computeDrawdown(new Big("970"), new Big("1000"));
    expect(drawdown.toString()).toBe("0.03");
  });

  it("returns zero when current equity equals the peak", () => {
    expect(computeDrawdown(new Big("1000"), new Big("1000")).toString()).toBe("0");
  });

  it("returns zero (not negative) when current equity exceeds the stored peak — the caller hasn't updated its peak yet", () => {
    expect(computeDrawdown(new Big("1100"), new Big("1000")).toString()).toBe("0");
  });
});

describe("checkDrawdown", () => {
  it("allows just below the 3% threshold (PARAMS-CONSERVATIVE.md §8)", () => {
    const result = checkDrawdown(new Big("971"), new Big("1000")); // drawdown 0.029
    expect(result.allowed).toBe(true);
  });

  it("denies exactly at the 3% boundary — inclusive deny, per brief §7: better to stop unnecessarily than fail to stop once", () => {
    const result = checkDrawdown(new Big("970"), new Big("1000")); // drawdown 0.03 exactly
    expect(result).toMatchObject({ allowed: false, code: "DRAWDOWN_EXCEEDED" });
  });

  it("denies above the threshold", () => {
    const result = checkDrawdown(new Big("900"), new Big("1000")); // drawdown 0.10
    expect(result.allowed).toBe(false);
  });

  it("allows at zero drawdown (equity at or above peak)", () => {
    expect(checkDrawdown(new Big("1000"), new Big("1000")).allowed).toBe(true);
    expect(checkDrawdown(new Big("1050"), new Big("1000")).allowed).toBe(true);
  });
});
