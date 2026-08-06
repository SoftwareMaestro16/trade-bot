import Big from "big.js";
import { describe, expect, it } from "vitest";
import { computeBorrowCost8h } from "../../src/emulation/borrowCost.js";
import { computeNetFundingRate } from "../../src/risk/economics.js";

describe("computeBorrowCost8h", () => {
  it("returns exactly zero at leverage=1 (baseline, no borrowing) regardless of notional or rate — PARAMS-CONSERVATIVE.md §6 'spot only with own money' is the key invariant this function must never violate", () => {
    expect(computeBorrowCost8h(new Big("1"), new Big("1000"), new Big("0.00005")).toString()).toBe("0");
    expect(computeBorrowCost8h(new Big("1"), new Big("0"), new Big("0.00005")).toString()).toBe("0");
    expect(computeBorrowCost8h(new Big("1"), new Big("1000"), new Big("0")).toString()).toBe("0");
    // Large notional, large rate — the identity holds unconditionally, not just for "small" test numbers.
    expect(computeBorrowCost8h(new Big("1"), new Big("1000000000"), new Big("0.01")).toString()).toBe("0");
  });

  it("borrows and charges interest on exactly half the notional at leverage=2", () => {
    // borrowedFraction = 1 - 1/2 = 0.5; rate8h(if fully borrowed) = 0.00005*8 = 0.0004; result = 0.5*0.0004.
    const result = computeBorrowCost8h(new Big("2"), new Big("1000"), new Big("0.00005"));
    expect(result.toString()).toBe("0.0002");
  });

  it("borrows 75% of notional at leverage=4", () => {
    // borrowedFraction = 1 - 1/4 = 0.75; rate8h = 0.0001*8 = 0.0008; result = 0.75*0.0008.
    const result = computeBorrowCost8h(new Big("4"), new Big("500"), new Big("0.0001"));
    expect(result.toString()).toBe("0.0006");
  });

  it("handles a non-integer leverage (1.25) that still divides evenly — borrows exactly 20%", () => {
    // borrowedFraction = 1 - 1/1.25 = 1 - 0.8 = 0.2; rate8h = 0.00002*8 = 0.00016; result = 0.2*0.00016.
    const result = computeBorrowCost8h(new Big("1.25"), new Big("200"), new Big("0.00002"));
    expect(result.toString()).toBe("0.000032");
  });

  it("is independent of positionNotional — a RATE relative to the position's own notional, not a dollar amount, so it cancels out algebraically (documented invariant, not an oversight)", () => {
    const tiny = computeBorrowCost8h(new Big("2"), new Big("1"), new Big("0.00005"));
    const huge = computeBorrowCost8h(new Big("2"), new Big("1000000000"), new Big("0.00005"));
    expect(tiny.toString()).toBe("0.0002");
    expect(huge.toString()).toBe("0.0002");
  });

  it("positionNotional=0 still returns the leverage/rate-driven rate, not zero — guards against a naive implementation that derives the rate by dividing a dollar cost by notional (which would be a 0/0 crash or a false zero here)", () => {
    const result = computeBorrowCost8h(new Big("2"), new Big("0"), new Big("0.00005"));
    expect(result.toString()).toBe("0.0002");
  });

  it("zero hourlyBorrowRate yields zero cost regardless of leverage", () => {
    const result = computeBorrowCost8h(new Big("10"), new Big("500"), new Big("0"));
    expect(result.toString()).toBe("0");
  });

  it("boundary: a leverage infinitesimally above 1 already produces a nonzero cost — the leverage=1 zero is a true algebraic boundary, not a clamped/rounded range", () => {
    const result = computeBorrowCost8h(new Big("1.00000001"), new Big("1000"), new Big("0.00005"));
    expect(result.gt(0)).toBe(true);
    expect(result.lt(new Big("0.00000001"))).toBe(true);
  });

  it("approaches hourlyBorrowRate×8 as leverage grows very large — the FM-09 'fully borrowed' limit. RISK-REGISTER.md FM-09's VIP0 snapshot (2026-08-05): hourlyBorrowRate=0.0000044069 (≈3.860% APR) implies ~0.000035/8h when fully borrowed, matching FM-09's own claim that this eats ~35% of a 0.0001 r8h — a cross-check against the risk register's own arithmetic, not just this function's internal consistency", () => {
    const hourlyBorrowRate = new Big("0.0000044069"); // FM-09 snapshot — illustrative cross-check only, never a hardcoded production default (see this module's own doc comment)
    const fullyBorrowedLimit = hourlyBorrowRate.times(8);
    const result = computeBorrowCost8h(new Big("100000"), new Big("500"), hourlyBorrowRate);
    const diff = fullyBorrowedLimit.minus(result).abs();
    expect(diff.lt(new Big("0.000000001"))).toBe(true);
  });

  it("composes directly with risk/economics.ts's computeNetFundingRate as documented (RR-25a) — same r8h basis and sign end to end", () => {
    const borrowCost8h = computeBorrowCost8h(new Big("2"), new Big("1000"), new Big("0.00005"));
    const net = computeNetFundingRate(new Big("0.001"), borrowCost8h);
    expect(net.toString()).toBe("0.0008"); // 0.001 - 0.0002
  });

  it("throws RangeError instead of a silently-wrong result when leverage is below 1 — not a real financing state (the 'borrowed' slice would be negative)", () => {
    expect(() => computeBorrowCost8h(new Big("0.99"), new Big("1000"), new Big("0.00005"))).toThrow(RangeError);
  });

  it("throws RangeError when leverage is exactly zero", () => {
    expect(() => computeBorrowCost8h(new Big("0"), new Big("1000"), new Big("0.00005"))).toThrow(RangeError);
  });

  it("throws RangeError when leverage is negative", () => {
    expect(() => computeBorrowCost8h(new Big("-2"), new Big("1000"), new Big("0.00005"))).toThrow(RangeError);
  });

  it("throws RangeError when positionNotional is negative — not a real position size", () => {
    expect(() => computeBorrowCost8h(new Big("2"), new Big("-1"), new Big("0.00005"))).toThrow(RangeError);
  });
});
