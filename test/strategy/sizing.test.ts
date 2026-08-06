import Big from "big.js";
import { describe, expect, it } from "vitest";
import { sizePosition } from "../../src/strategy/sizing.js";

describe("sizePosition", () => {
  it("denies on BTC-scale residual delta at a Phase-4-realistic $500 notional (RISK-REGISTER.md FM-12's own worked example)", () => {
    // PARAMS-CONSERVATIVE.md §1: BTC's qtyStep at boevoy sizes gives up to ~32% mismatch —
    // this pins the exact number that finding was based on.
    const result = sizePosition({
      targetNotional: new Big("500"),
      markPrice: new Big("64725.90"),
      perpQtyStep: new Big("0.001"),
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("RESIDUAL_DELTA_EXCEEDED");
      expect(result.reason).toContain("0.0647259");
    }
  });

  it("allows and sizes correctly on a fine-grained symbol at the same notional", () => {
    const result = sizePosition({
      targetNotional: new Big("500"),
      markPrice: new Big("1"),
      perpQtyStep: new Big("0.1"),
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.perpQty.toString()).toBe("500");
      expect(result.spotQty.toString()).toBe(result.perpQty.toString()); // 1:1, no multiplier handling (RSK-13 out of scope)
      expect(result.residualDeltaFraction.toString()).toBe("0.0001");
    }
  });

  it("rounds DOWN (never nearest, never up) when the raw quantity doesn't land on a step boundary", () => {
    // rawQty = 1.239 -> stepCount 123.9 -> floors to 123, NOT 124 (which ROUND_HALF_UP would give).
    const result = sizePosition({
      targetNotional: new Big("123.9"),
      markPrice: new Big("100"),
      perpQtyStep: new Big("0.01"),
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.perpQty.toString()).toBe("1.23");
    }
  });

  it("allows exactly at the 0.005 residual-delta boundary", () => {
    // (1/2 * 1) / 100 = 0.005 exactly.
    const result = sizePosition({
      targetNotional: new Big("100"),
      markPrice: new Big("1"),
      perpQtyStep: new Big("1"),
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.residualDeltaFraction.toString()).toBe("0.005");
    }
  });

  it("denies just past the 0.005 boundary", () => {
    // (1/2 * 1) / 99 = 0.00505... > 0.005.
    const result = sizePosition({
      targetNotional: new Big("99"),
      markPrice: new Big("1"),
      perpQtyStep: new Big("1"),
    });
    expect(result.allowed).toBe(false);
  });

  it("accepts a custom maxResidualDeltaFraction override", () => {
    const strict = sizePosition({
      targetNotional: new Big("500"),
      markPrice: new Big("1"),
      perpQtyStep: new Big("0.1"),
      maxResidualDeltaFraction: new Big("0.00001"), // far stricter than the 0.0001 this scenario produces
    });
    expect(strict.allowed).toBe(false);
  });
});
