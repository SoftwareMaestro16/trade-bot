import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  deriveIntervalMinutesFromTimestamps,
  normalizeFundingRateToR8h,
  r8hToApr,
} from "../../src/market-data/normalizeFunding.js";

describe("normalizeFundingRateToR8h", () => {
  // RISK-REGISTER.md TEST-CASES.md #52: exact pinned values.
  it("rate=0.0001, interval=60min -> r8h=0.0008 (hourly settlement, 8x more frequent)", () => {
    const result = normalizeFundingRateToR8h(new Big("0.0001"), 60);
    expect(result.toString()).toBe("0.0008");
  });

  it("rate=0.0001, interval=240min -> r8h=0.0002 (4h settlement, 2x more frequent)", () => {
    const result = normalizeFundingRateToR8h(new Big("0.0001"), 240);
    expect(result.toString()).toBe("0.0002");
  });

  it("rate=0.0001, interval=480min -> r8h=0.0001 (already the reference interval, identity)", () => {
    const result = normalizeFundingRateToR8h(new Big("0.0001"), 480);
    expect(result.toString()).toBe("0.0001");
  });

  it("throws on a non-positive interval rather than silently producing Infinity/NaN", () => {
    expect(() => normalizeFundingRateToR8h(new Big("0.0001"), 0)).toThrow(RangeError);
    expect(() => normalizeFundingRateToR8h(new Big("0.0001"), -60)).toThrow(RangeError);
  });

  it("does not restrict to the currently-known interval set (a new Bybit interval is still normalized correctly)", () => {
    // FM-04: hardcoding {60,120,240,480} here would repeat the exact mistake this
    // function exists to prevent — a live instruments-info field is authoritative.
    const result = normalizeFundingRateToR8h(new Big("0.0003"), 30);
    expect(result.toString()).toBe("0.0048");
  });
});

describe("r8hToApr", () => {
  it("annualizes r8h at 1095 periods/year (365*24/8), simple non-compounded", () => {
    const apr = r8hToApr(new Big("0.0001"));
    // 0.0001 * 1095 = 0.1095
    expect(apr.toString()).toBe("0.1095");
  });

  it("FM-01 fixture: 0.02%/8h is the recommended minimum entry threshold", () => {
    const apr = r8hToApr(new Big("0.0002"));
    // 0.0002 * 1095 = 0.219 -> 21.9% APR, matches DECISIONS.md's worked example
    expect(apr.toString()).toBe("0.219");
  });
});

describe("deriveIntervalMinutesFromTimestamps", () => {
  const MIN = 60_000;

  it.each([
    [60, "hourly"],
    [120, "2h"],
    [240, "4h"],
    [480, "8h"],
  ])("accepts a known interval gap of %i minutes (%s)", (minutes) => {
    const earlier = 0;
    const later = minutes * MIN;
    expect(deriveIntervalMinutesFromTimestamps(earlier, later)).toBe(minutes);
  });

  it("throws loudly on a gap outside the known set instead of silently averaging (FM-04)", () => {
    const earlier = 0;
    const later = 300 * MIN; // 5h — not a documented Bybit interval
    expect(() => deriveIntervalMinutesFromTimestamps(earlier, later)).toThrow(RangeError);
  });

  it("throws on a zero or negative gap (duplicate or out-of-order timestamps)", () => {
    expect(() => deriveIntervalMinutesFromTimestamps(1000, 1000)).toThrow(RangeError);
    expect(() => deriveIntervalMinutesFromTimestamps(1000, 0)).toThrow(RangeError);
  });
});
