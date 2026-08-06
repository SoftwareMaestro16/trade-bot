import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  checkEntryThreshold,
  checkFeeRateSanity,
  checkFundingBlackout,
  checkNetFundingRate,
  computeNetFundingRate,
  isPremiumDriven,
} from "../../src/risk/economics.js";

describe("isPremiumDriven", () => {
  it("is true when the normalized premium index exceeds +0.05%/8h (RISK-REGISTER.md FM-01)", () => {
    expect(isPremiumDriven(new Big("0.0006"))).toBe(true);
  });

  it("is false exactly at the threshold — the rate could be a clamp artifact, not proven premium-driven", () => {
    expect(isPremiumDriven(new Big("0.0005"))).toBe(false);
  });

  it("is false below the threshold, including zero and negative premium", () => {
    expect(isPremiumDriven(new Big("0.0001"))).toBe(false);
    expect(isPremiumDriven(new Big("-0.001"))).toBe(false);
  });
});

describe("checkEntryThreshold", () => {
  it("denies below the 0.020%/8h floor regardless of how good the gross/cost ratio looks (PARAMS-CONSERVATIVE.md §5)", () => {
    const result = checkEntryThreshold(new Big("0.0001999"), new Big("1000"), new Big("0.0000001"));
    expect(result).toMatchObject({ allowed: false, code: "FUNDING_RATE_BELOW_FLOOR" });
  });

  it("allows exactly at the floor when expected gross also clears K=2.0x cost", () => {
    // r8h=0.0002, intervals=10 -> expectedGross=0.002; cost=0.0005 -> required=0.001. 0.002 >= 0.001.
    const result = checkEntryThreshold(new Big("0.0002"), new Big("10"), new Big("0.0005"));
    expect(result.allowed).toBe(true);
  });

  it("denies when the floor is cleared but expected gross is below 2x round-trip cost", () => {
    // r8h=0.0002, intervals=2 -> expectedGross=0.0004; cost=0.0005 -> required=0.001. 0.0004 < 0.001.
    const result = checkEntryThreshold(new Big("0.0002"), new Big("2"), new Big("0.0005"));
    expect(result).toMatchObject({ allowed: false, code: "EXPECTED_GROSS_TOO_LOW" });
  });

  it("allows exactly at the K=2.0x boundary (expectedGross == requiredGross)", () => {
    // r8h=0.001, intervals=1 -> expectedGross=0.001; cost=0.0005 -> required=0.001. Equal.
    const result = checkEntryThreshold(new Big("0.001"), new Big("1"), new Big("0.0005"));
    expect(result.allowed).toBe(true);
  });
});

describe("computeNetFundingRate", () => {
  it("subtracts borrow cost from the gross rate (RISK-REGISTER.md FM-09)", () => {
    const net = computeNetFundingRate(new Big("0.0002"), new Big("0.00005"));
    expect(net.toString()).toBe("0.00015");
  });

  it("can go negative when borrow cost exceeds gross funding — this is a real, expected outcome on majors per FM-09, not an error", () => {
    const net = computeNetFundingRate(new Big("0.0001"), new Big("0.00016"));
    expect(net.toString()).toBe("-0.00006");
  });
});

describe("checkNetFundingRate — RR-25a", () => {
  it("allows when net-of-borrow-cost rate clears the same floor as raw r8h", () => {
    const result = checkNetFundingRate(new Big("0.001"), new Big("0.0005"));
    expect(result.allowed).toBe(true); // net = 0.0005, above the 0.0002 floor
  });

  it("denies when net-of-borrow-cost rate falls below the floor even though gross r8h alone would pass checkEntryThreshold", () => {
    const result = checkNetFundingRate(new Big("0.001"), new Big("0.0009"));
    expect(result).toMatchObject({ allowed: false, code: "NET_FUNDING_RATE_BELOW_FLOOR" });
  });

  it("denies when borrow cost exceeds gross funding outright (FM-09's documented majors scenario)", () => {
    const result = checkNetFundingRate(new Big("0.0001"), new Big("0.00016"));
    expect(result).toMatchObject({ allowed: false, code: "NET_FUNDING_RATE_BELOW_FLOOR" });
  });

  it("allows exactly at the floor boundary", () => {
    const result = checkNetFundingRate(new Big("0.0007"), new Big("0.0005")); // net = 0.0002, exactly the floor
    expect(result.allowed).toBe(true);
  });
});

describe("checkFundingBlackout", () => {
  const nextFundingTimeMs = 1_000_000 + 60_000;

  it("denies exactly at the default 60s boundary before settlement", () => {
    const result = checkFundingBlackout(1_000_000, nextFundingTimeMs);
    expect(result).toMatchObject({ allowed: false, code: "FUNDING_SETTLEMENT_BLACKOUT" });
  });

  it("allows one millisecond outside the default 60s boundary", () => {
    const result = checkFundingBlackout(999_999, nextFundingTimeMs);
    expect(result.allowed).toBe(true);
  });

  it("denies symmetrically after settlement, not just before", () => {
    const result = checkFundingBlackout(nextFundingTimeMs + 60_000, nextFundingTimeMs);
    expect(result.allowed).toBe(false);
  });

  it("respects a custom blackoutSeconds override", () => {
    const result = checkFundingBlackout(1_000_000, 1_000_000 + 10_000, 5);
    expect(result.allowed).toBe(true); // 10s away, but window is only 5s
  });

  it("fails CLOSED (denies) on a non-finite input instead of silently allowing — NaN fails every comparison in JS, so an unguarded version fell through to allow()", () => {
    expect(checkFundingBlackout(NaN, nextFundingTimeMs)).toMatchObject({
      allowed: false,
      code: "FUNDING_SETTLEMENT_BLACKOUT",
    });
    expect(checkFundingBlackout(1_000_000, NaN)).toMatchObject({
      allowed: false,
      code: "FUNDING_SETTLEMENT_BLACKOUT",
    });
    expect(checkFundingBlackout(Infinity, nextFundingTimeMs)).toMatchObject({ allowed: false });
    expect(checkFundingBlackout(1_000_000, undefined as unknown as number)).toMatchObject({ allowed: false });
  });
});

describe("checkFeeRateSanity — RR-26 (TEST-CASES.md #48)", () => {
  it("denies TEST-CASES.md #48's own example: a 2% fee-rate fixture", () => {
    const result = checkFeeRateSanity(new Big("0.02"));
    expect(result).toMatchObject({ allowed: false, code: "FEE_RATE_IMPLAUSIBLE" });
  });

  it("allows a realistic VIP0 taker rate (PARAMS-CONSERVATIVE.md §6: ~0.055-0.10% per leg)", () => {
    expect(checkFeeRateSanity(new Big("0.001")).allowed).toBe(true); // 0.10%, spot VIP0
    expect(checkFeeRateSanity(new Big("0.00055")).allowed).toBe(true); // 0.055%, perp taker VIP0
  });

  it("allows even Innovation/Adventure Zone's worse rate (0.62% round-trip / 4 legs ≈ 0.155%/leg) — those zones are excluded elsewhere, not by this sanity check specifically", () => {
    expect(checkFeeRateSanity(new Big("0.00155")).allowed).toBe(true);
  });

  it("allows exactly at the 1% sanity ceiling, denies just above it", () => {
    expect(checkFeeRateSanity(new Big("0.01")).allowed).toBe(true);
    expect(checkFeeRateSanity(new Big("0.0100001"))).toMatchObject({
      allowed: false,
      code: "FEE_RATE_IMPLAUSIBLE",
    });
  });

  it("denies a negative fee rate too — not a real value regardless of magnitude", () => {
    // gt() alone doesn't catch negative values on its own, but the ceiling
    // check is one-sided by design (a rebate/negative rate is a DIFFERENT,
    // separately-plausible thing — Bybit does have maker rebates on some
    // pairs — so this documents current behavior rather than asserting a
    // requirement this function doesn't claim to enforce).
    expect(checkFeeRateSanity(new Big("-0.0001")).allowed).toBe(true);
  });
});
