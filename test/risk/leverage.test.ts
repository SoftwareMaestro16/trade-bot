import Big from "big.js";
import { describe, expect, it } from "vitest";
import { checkAccountMMRate, checkConcentration, checkLeverage } from "../../src/risk/leverage.js";
import type { VetoResult } from "../../src/risk/types.js";

// Narrows to the denial branch and checks that `code`/`reason` are both present
// and non-empty — a bare `{allowed:false}` with an empty reason would satisfy the
// type system but fail RR-28/FR-307's "machine-readable reason on every denial".
function expectDenied(result: VetoResult, code: string): void {
  if (result.allowed) {
    throw new Error(`expected a denial with code ${code}, but the check allowed`);
  }
  expect(result.code).toBe(code);
  expect(result.reason.length).toBeGreaterThan(0);
}

describe("checkLeverage", () => {
  it("allows the 1.0x target working leverage (PARAMS-CONSERVATIVE.md §10)", () => {
    const result = checkLeverage(new Big("100"), new Big("100"));
    expect(result.allowed).toBe(true);
  });

  it("denies leverage well above the 1.5x ceiling (RR-20)", () => {
    const result = checkLeverage(new Big("2"), new Big("1"));
    expectDenied(result, "LEVERAGE_EXCEEDED");
  });

  it("boundary: just under 1.5x is allowed", () => {
    const result = checkLeverage(new Big("1.49999999"), new Big("1"));
    expect(result.allowed).toBe(true);
  });

  it("boundary: exactly 1.5x is allowed — the hard ceiling is inclusive (RR-20)", () => {
    const result = checkLeverage(new Big("1.5"), new Big("1"));
    expect(result.allowed).toBe(true);
  });

  it("boundary: one minimal step over 1.5x is denied", () => {
    const result = checkLeverage(new Big("1.50000001"), new Big("1"));
    expectDenied(result, "LEVERAGE_EXCEEDED");
  });

  it("throws RangeError instead of a veto when totalEquity is zero — an impossible business state, not a risk outcome", () => {
    expect(() => checkLeverage(new Big("100"), new Big("0"))).toThrow(RangeError);
  });

  it("throws RangeError instead of a veto when totalEquity is negative", () => {
    expect(() => checkLeverage(new Big("100"), new Big("-100"))).toThrow(RangeError);
  });

  it("denies a negative shortNotional instead of silently allowing — a negative notional implies an upstream sign/subtraction bug and must fail closed, the same way totalEquity<=0 above and checkFundingBlackout's non-finite guard do", () => {
    const result = checkLeverage(new Big("-100"), new Big("100"));
    expectDenied(result, "LEVERAGE_NOTIONAL_IMPLAUSIBLE");
  });
});

describe("checkAccountMMRate", () => {
  it("allows a comfortably safe projected account MMR", () => {
    const result = checkAccountMMRate(new Big("0.15"));
    expect(result.allowed).toBe(true);
  });

  it("denies a projected account MMR well past the ceiling (FM-25: account-level UTA liquidation)", () => {
    const result = checkAccountMMRate(new Big("0.5"));
    expectDenied(result, "ACCOUNT_MMR_EXCEEDED");
  });

  it("boundary: just under ACCOUNT_MMR_MAX (0.30) is allowed", () => {
    const result = checkAccountMMRate(new Big("0.29999999"));
    expect(result.allowed).toBe(true);
  });

  it("boundary: exactly 0.30 is denied — the threshold itself is unsafe, unlike checkLeverage/checkConcentration (FM-25, RR-20a)", () => {
    const result = checkAccountMMRate(new Big("0.30"));
    expectDenied(result, "ACCOUNT_MMR_EXCEEDED");
  });

  it("boundary: one minimal step over 0.30 is denied", () => {
    const result = checkAccountMMRate(new Big("0.30000001"));
    expectDenied(result, "ACCOUNT_MMR_EXCEEDED");
  });
});

describe("checkConcentration", () => {
  it("allows a comfortably safe concentration", () => {
    const result = checkConcentration(new Big("20"), new Big("100"));
    expect(result.allowed).toBe(true);
  });

  it("denies concentration above the 25% single-coin cap (RR-21)", () => {
    const result = checkConcentration(new Big("30"), new Big("100"));
    expectDenied(result, "CONCENTRATION_EXCEEDED");
  });

  it("boundary: just under 25% is allowed", () => {
    const result = checkConcentration(new Big("0.24999999"), new Big("1"));
    expect(result.allowed).toBe(true);
  });

  it("boundary: exactly 25% is allowed — the cap is inclusive, same convention as checkLeverage (PARAMS-CONSERVATIVE.md §11)", () => {
    const result = checkConcentration(new Big("0.25"), new Big("1"));
    expect(result.allowed).toBe(true);
  });

  it("boundary: one minimal step over 25% is denied", () => {
    const result = checkConcentration(new Big("0.25000001"), new Big("1"));
    expectDenied(result, "CONCENTRATION_EXCEEDED");
  });

  it("denies a negative spotLegNotional instead of silently allowing — same one-sided-ceiling gap as checkLeverage would otherwise leave open: `.gt(CONCENTRATION_MAX)` never fires for a negative ratio, so this must fail closed before reaching that comparison", () => {
    const result = checkConcentration(new Big("-30"), new Big("100"));
    expectDenied(result, "CONCENTRATION_NOTIONAL_IMPLAUSIBLE");
  });

  // checkConcentration now guards `totalEquity <= 0` the same way checkLeverage
  // in this same file does — a documented RangeError, not a veto outcome.
  // checkConcentration is invoked directly by callers other than checkEntry
  // (e.g. TEST-CASES.md #63 in test/risk/index.test.ts calls it standalone),
  // so checkEntry's fixed check order (checkLeverage runs first and would
  // already have thrown) cannot be relied on to protect every caller from a
  // zero/negative-equity input reaching checkConcentration directly — the
  // guard has to live here too.
  it("totalEquity zero: throws the same documented RangeError as checkLeverage for the identical input shape", () => {
    expect(() => checkConcentration(new Big("20"), new Big("0"))).toThrow(RangeError);
  });

  it("totalEquity negative: throws RangeError instead of silently allowing — dividing by a negative used to flip the sign, making concentration always <= CONCENTRATION_MAX", () => {
    expect(() => checkConcentration(new Big("20"), new Big("-100"))).toThrow(RangeError);
  });
});
