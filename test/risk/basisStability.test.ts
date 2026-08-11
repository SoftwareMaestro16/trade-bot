import Big from "big.js";
import { describe, expect, it } from "vitest";
import { checkBasisStability } from "../../src/risk/basisStability.js";

/** PARAMS-CONSERVATIVE.md §7.3's emergency exit, the bar every case below measures against. */
const STOP = new Big("0.005");

describe("checkBasisStability — real symbols that motivated the check", () => {
  // Measured basis standard deviations, 2026-08-06..08-10 (see module doc).
  // Entered at a basis near zero in every real trade, so zero is used here to
  // isolate the volatility term from the position term.
  const flat = new Big("0");

  it.each([
    ["ZBTUSDT", "0.002635"],
    ["GRVTUSDT", "0.002172"],
    ["CAPUSDT", "0.002033"],
  ])("denies %s, whose basis reaches the stop inside 3 sigma (all three lost money)", (_symbol, sd) => {
    const result = checkBasisStability(flat, new Big(sd), STOP);
    expect(result).toMatchObject({ allowed: false, code: "BASIS_TOO_VOLATILE" });
  });

  it.each([
    ["HYPEUSDT", "0.000190"],
    ["SOLUSDT", "0.000134"],
    ["BTCUSDT", "0.000067"],
    ["ETHUSDT", "0.000066"],
  ])("allows %s, where the stop is tens of sigma away", (_symbol, sd) => {
    expect(checkBasisStability(flat, new Big(sd), STOP).allowed).toBe(true);
  });
});

describe("checkBasisStability — the sigma boundary", () => {
  it("allows exactly at the required sigma count", () => {
    // Built from exactly-representable decimals (0.003 / 0.001 = 3) rather than
    // STOP.div(MIN_SIGMAS_TO_STOP): 0.005/3 is a repeating decimal, so Big
    // rounds it and the round trip lands at 2.9999... — which this check then
    // (correctly, fail-closed) denies. That rounding behaviour is fine in
    // production; it just cannot be used to construct an exact boundary.
    expect(checkBasisStability(new Big("0"), new Big("0.001"), new Big("0.003")).allowed).toBe(true);
  });

  it("denies a hair inside the boundary", () => {
    expect(checkBasisStability(new Big("0"), new Big("0.001"), new Big("0.00299"))).toMatchObject({
      allowed: false,
      code: "BASIS_TOO_VOLATILE",
    });
  });

  it("honours a caller-supplied sigma requirement", () => {
    const sd = new Big("0.001"); // 5 sigma of room from a flat basis
    expect(checkBasisStability(new Big("0"), sd, STOP, new Big("5")).allowed).toBe(true);
    expect(checkBasisStability(new Big("0"), sd, STOP, new Big("6")).allowed).toBe(false);
  });
});

describe("checkBasisStability — room is measured from the CURRENT basis, not from zero", () => {
  const calm = new Big("0.0005"); // 10 sigma of room when the basis is flat

  it("allows the calm pair when the basis sits at zero", () => {
    expect(checkBasisStability(new Big("0"), calm, STOP).allowed).toBe(true);
  });

  it("denies the SAME pair once the basis has already travelled most of the way to the stop", () => {
    // room = 0.005 - 0.0040 = 0.001 -> only 2 sigma left.
    expect(checkBasisStability(new Big("0.0040"), calm, STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_TOO_VOLATILE",
    });
  });

  it("treats a negative basis by magnitude — direction of the excursion is irrelevant to the stop", () => {
    expect(checkBasisStability(new Big("-0.0040"), calm, STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_TOO_VOLATILE",
    });
  });

  it("denies with its own code when the basis is already at or past the stop", () => {
    expect(checkBasisStability(new Big("0.005"), calm, STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_ALREADY_AT_STOP",
    });
    expect(checkBasisStability(new Big("-0.006"), calm, STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_ALREADY_AT_STOP",
    });
  });
});

describe("checkBasisStability — degenerate inputs fail closed", () => {
  it("denies when volatility is unknown rather than assuming the basis is calm", () => {
    expect(checkBasisStability(new Big("0"), null, STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_VOLATILITY_UNKNOWN",
    });
  });

  it("denies a negative standard deviation instead of dividing by it", () => {
    expect(checkBasisStability(new Big("0"), new Big("-0.001"), STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_VOLATILITY_IMPLAUSIBLE",
    });
  });

  it("allows a perfectly still basis without dividing by zero", () => {
    expect(checkBasisStability(new Big("0"), new Big("0"), STOP).allowed).toBe(true);
  });

  it("still denies a still basis that is already parked at the stop", () => {
    // The zero-deviation shortcut must not run before the already-at-stop check.
    expect(checkBasisStability(new Big("0.006"), new Big("0"), STOP)).toMatchObject({
      allowed: false,
      code: "BASIS_ALREADY_AT_STOP",
    });
  });
});
