import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  buildLowCoverageCaveat,
  buildTelegramCaption,
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

describe("buildTelegramCaption", () => {
  it("reports a profit with an explicit + sign on both the dollar and percent figures", () => {
    const caption = buildTelegramCaption("run-1", new Big("1000"), new Big("1050"), 3, 3, 200, null);
    expect(caption).toContain("$1000.00 -> $1050.00");
    expect(caption).toContain("(+50.00 / +5.00%)");
    expect(caption).toContain("Сделок: 3 открыто / 3 закрыто");
    expect(caption).not.toContain("PRELIMINARY");
  });

  it("reports a loss with an explicit - sign (Big.js's own toFixed doesn't add + but does add -)", () => {
    const caption = buildTelegramCaption("run-2", new Big("1000"), new Big("950"), 5, 5, 200, null);
    expect(caption).toContain("$1000.00 -> $950.00");
    expect(caption).toContain("(-50.00 / -5.00%)");
  });

  it("surfaces the PRELIMINARY marker when a low-coverage caveat was produced, and includes the run id/coverage hours", () => {
    const caveat = buildLowCoverageCaveat(24, 7 * 24);
    const caption = buildTelegramCaption("preliminary-real-data-run-7", new Big("1000"), new Big("1000"), 0, 0, 24, caveat);
    expect(caption).toContain('Эмуляция "preliminary-real-data-run-7"');
    expect(caption).toContain("Окно данных: 24.0ч (PRELIMINARY — ниже 168ч минимума)");
    expect(caption).toContain("Сделок: 0 открыто / 0 закрыто");
  });

  it("omits the PRELIMINARY marker once coverage clears the threshold, even though the caption doesn't recompute it itself", () => {
    const caption = buildTelegramCaption("run-3", new Big("1000"), new Big("1000"), 1, 1, 200, null);
    expect(caption).not.toContain("PRELIMINARY");
    expect(caption).toContain("Окно данных: 200.0ч");
  });

  it("mentions that per-trade detail lives in the attached files, not the caption itself", () => {
    const caption = buildTelegramCaption("run-4", new Big("1000"), new Big("1000"), 0, 0, 200, null);
    expect(caption).toContain("приложенных файлах");
  });
});
