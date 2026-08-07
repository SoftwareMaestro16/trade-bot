import { describe, expect, it } from "vitest";
import {
  buildLowCoverageCaveat,
  computeCoverageHours,
  resolveObservedRange,
} from "../../src/scripts/runEmulationScenario.js";

describe("resolveObservedRange", () => {
  it("throws when minAt is null (empty tickers table)", () => {
    expect(() => resolveObservedRange({ minAt: null, maxAt: new Date() })).toThrow(
      /tickers table is empty/,
    );
  });

  it("throws when maxAt is null (empty tickers table)", () => {
    expect(() => resolveObservedRange({ minAt: new Date(), maxAt: null })).toThrow(
      /tickers table is empty/,
    );
  });

  it("throws when both minAt and maxAt are null (empty tickers table)", () => {
    expect(() => resolveObservedRange({ minAt: null, maxAt: null })).toThrow(
      /tickers table is empty/,
    );
  });

  it("returns startAt/endAt unchanged when both are present", () => {
    const minAt = new Date("2026-01-01T00:00:00.000Z");
    const maxAt = new Date("2026-01-02T00:00:00.000Z");
    expect(resolveObservedRange({ minAt, maxAt })).toEqual({ startAt: minAt, endAt: maxAt });
  });
});

describe("computeCoverageHours", () => {
  it("converts a millisecond span into hours", () => {
    const startAt = new Date("2026-01-01T00:00:00.000Z");
    const endAt = new Date("2026-01-08T00:00:00.000Z"); // exactly 7 days later
    expect(computeCoverageHours(startAt, endAt)).toBe(7 * 24);
  });

  it("handles a sub-hour span without flipping sign or units", () => {
    const startAt = new Date("2026-01-01T00:00:00.000Z");
    const endAt = new Date("2026-01-01T00:30:00.000Z"); // 30 minutes later
    expect(computeCoverageHours(startAt, endAt)).toBe(0.5);
  });

  it("returns a negative value (not clamped) if endAt precedes startAt", () => {
    const startAt = new Date("2026-01-08T00:00:00.000Z");
    const endAt = new Date("2026-01-01T00:00:00.000Z");
    expect(computeCoverageHours(startAt, endAt)).toBe(-7 * 24);
  });
});

describe("buildLowCoverageCaveat", () => {
  const thresholdHours = 7 * 24;

  it("returns the loud PRELIMINARY / LOW-CONFIDENCE caveat when coverage is below the threshold", () => {
    const caveat = buildLowCoverageCaveat(24, thresholdHours);
    expect(caveat).not.toBeNull();
    expect(caveat).toContain("PRELIMINARY / LOW-CONFIDENCE RUN");
    expect(caveat).toContain("24.0h of data");
  });

  it("stays silent (returns null) once coverage reaches the threshold", () => {
    expect(buildLowCoverageCaveat(thresholdHours, thresholdHours)).toBeNull();
  });

  it("stays silent (returns null) comfortably above the threshold", () => {
    expect(buildLowCoverageCaveat(thresholdHours * 2, thresholdHours)).toBeNull();
  });
});
