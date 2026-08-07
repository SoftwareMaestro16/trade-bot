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

  // Like checkLeverage's `totalEquity <= 0`, computeDrawdown now has an
  // explicit RangeError guard for `peakEquity <= 0`, with its own doc comment
  // explaining why: unlike currentEquity (which legitimately reaches
  // zero/negative at liquidation-magnitude moves, per
  // src/emulation/equityEngine.ts's doc comment), a *peak* is by construction
  // the highest equity value the caller has ever sampled — zero-or-negative
  // means the peak tracker was never initialized or was corrupted. Before the
  // guard, this state produced either an uncaught Big.js internal error or,
  // worse, a silent allow (negative "drawdown" that could never reach the
  // 0.03 threshold). These tests now document the controlled fail-closed
  // guard instead.
  describe("peakEquity <= 0 (guarded — same fail-closed pattern as checkLeverage's totalEquity <= 0 guard)", () => {
    it("throws a controlled RangeError, not Big.js's internal division-by-zero error, when peakEquity is exactly zero", () => {
      expect(() => computeDrawdown(new Big("-1"), new Big("0"))).toThrow(RangeError);
      expect(() => computeDrawdown(new Big("-1"), new Big("0"))).toThrow(/peakEquity must be positive/);
    });

    it("checkDrawdown propagates the same controlled RangeError instead of returning a veto result", () => {
      expect(() => checkDrawdown(new Big("-1"), new Big("0"))).toThrow(RangeError);
      expect(() => checkDrawdown(new Big("-1"), new Big("0"))).toThrow(/peakEquity must be positive/);
    });

    it("throws a controlled RangeError instead of producing a mathematically NEGATIVE drawdown fraction when both peak and current equity are negative and current is further underwater than peak", () => {
      // peakEquity(-50) is itself already a dead/liquidated account. Equity
      // then falls further to -100. Before the guard this entered the
      // division branch — (-50 - (-100)) / -50 = 50 / -50 = -1 — flipping the
      // sign on a further loss. Now the peakEquity <= 0 guard rejects it
      // before any division happens.
      expect(() => computeDrawdown(new Big("-100"), new Big("-50"))).toThrow(
        /peakEquity must be positive, got -50/,
      );
    });

    it("checkDrawdown throws instead of ALLOWING a deeper loss on an already-negative-equity account — the guard restores RR-40's intent instead of letting a negative drawdown fraction dodge the 0.03 threshold", () => {
      expect(() => checkDrawdown(new Big("-100"), new Big("-50"))).toThrow(RangeError);
    });
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
