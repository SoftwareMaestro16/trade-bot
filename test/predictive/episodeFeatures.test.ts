import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  computeFundingEpisodeFeatures,
  type ComputeFundingEpisodeFeaturesInput,
  type LiquidationSample,
  type OpenInterestSample,
  type SettledFundingSample,
} from "../../src/predictive/episodeFeatures.js";

const EPISODE_START_MS = new Date("2026-06-01T00:00:00.000Z").getTime();
const HOUR_MS = 60 * 60 * 1000;

function baseInput(overrides: Partial<ComputeFundingEpisodeFeaturesInput> = {}): ComputeFundingEpisodeFeaturesInput {
  return {
    symbol: "BTCUSDT",
    episodeStartMs: EPISODE_START_MS,
    startRate: new Big("0.0003"),
    startIntervalMinutes: 480,
    openInterestHistory: [],
    longShortRatioAtStart: undefined,
    liquidationHistory: [],
    fundingHistory: [],
    ...overrides,
  };
}

describe("computeFundingEpisodeFeatures", () => {
  it("normalizes r8h/apr at episode start via the shared normalizeFunding.ts helpers", () => {
    // 240min interval: r8h = rate * 480/240 = rate * 2
    const features = computeFundingEpisodeFeatures(
      baseInput({ startRate: new Big("0.0003"), startIntervalMinutes: 240 }),
    );
    expect(features.r8hAtStart.toString()).toBe("0.0006");
    // apr = r8h * (24*365/8)
    expect(features.aprAtStart.toString()).toBe(new Big("0.0006").times(24 * 365).div(8).toString());
  });

  describe("openInterestTrend", () => {
    it("reports up/down/flat direction with a signed percent change, using only samples inside the window", () => {
      const samples: OpenInterestSample[] = [
        // Out of window (25h before start, window is 24h) — must be ignored.
        { timestampMs: EPISODE_START_MS - 25 * HOUR_MS, openInterest: new Big("1") },
        // Deliberately out of chronological array order — the function must sort by timestamp.
        { timestampMs: EPISODE_START_MS, openInterest: new Big("120") },
        { timestampMs: EPISODE_START_MS - 20 * HOUR_MS, openInterest: new Big("100") },
      ];
      const features = computeFundingEpisodeFeatures(baseInput({ openInterestHistory: samples }));
      expect(features.openInterestTrend).toBeDefined();
      expect(features.openInterestTrend?.direction).toBe("up");
      expect(features.openInterestTrend?.changePercent.toString()).toBe("20");
      expect(features.openInterestTrend?.sampleCount).toBe(2);
      expect(features.openInterestTrend?.earliestOpenInterest.toString()).toBe("100");
      expect(features.openInterestTrend?.latestOpenInterest.toString()).toBe("120");
    });

    it("reports 'down' for a negative change and 'flat' for exactly zero change", () => {
      const down = computeFundingEpisodeFeatures(
        baseInput({
          openInterestHistory: [
            { timestampMs: EPISODE_START_MS - 10 * HOUR_MS, openInterest: new Big("100") },
            { timestampMs: EPISODE_START_MS, openInterest: new Big("80") },
          ],
        }),
      );
      expect(down.openInterestTrend?.direction).toBe("down");
      expect(down.openInterestTrend?.changePercent.toString()).toBe("-20");

      const flat = computeFundingEpisodeFeatures(
        baseInput({
          openInterestHistory: [
            { timestampMs: EPISODE_START_MS - 10 * HOUR_MS, openInterest: new Big("100") },
            { timestampMs: EPISODE_START_MS, openInterest: new Big("100") },
          ],
        }),
      );
      expect(flat.openInterestTrend?.direction).toBe("flat");
      expect(flat.openInterestTrend?.changePercent.toString()).toBe("0");
    });

    it("is undefined with fewer than two in-window samples — never defaults to a flat/zero trend", () => {
      const zeroSamples = computeFundingEpisodeFeatures(baseInput({ openInterestHistory: [] }));
      expect(zeroSamples.openInterestTrend).toBeUndefined();

      const oneSample = computeFundingEpisodeFeatures(
        baseInput({ openInterestHistory: [{ timestampMs: EPISODE_START_MS, openInterest: new Big("100") }] }),
      );
      expect(oneSample.openInterestTrend).toBeUndefined();
    });

    it("is undefined when the earliest in-window sample's open interest is zero (undefined percent change, not a divide-by-zero)", () => {
      const features = computeFundingEpisodeFeatures(
        baseInput({
          openInterestHistory: [
            { timestampMs: EPISODE_START_MS - 5 * HOUR_MS, openInterest: new Big("0") },
            { timestampMs: EPISODE_START_MS, openInterest: new Big("50") },
          ],
        }),
      );
      expect(features.openInterestTrend).toBeUndefined();
    });

    it("respects a custom window size", () => {
      const samples: OpenInterestSample[] = [
        { timestampMs: EPISODE_START_MS - 40 * HOUR_MS, openInterest: new Big("100") },
        { timestampMs: EPISODE_START_MS, openInterest: new Big("150") },
      ];
      const narrowWindow = computeFundingEpisodeFeatures(baseInput({ openInterestHistory: samples }), {
        openInterestTrendWindowHours: 24,
        liquidationWindowHours: 24,
        fundingVolatilityWindowHours: 720,
      });
      expect(narrowWindow.openInterestTrend).toBeUndefined(); // only 1 sample falls inside 24h

      const wideWindow = computeFundingEpisodeFeatures(baseInput({ openInterestHistory: samples }), {
        openInterestTrendWindowHours: 48,
        liquidationWindowHours: 24,
        fundingVolatilityWindowHours: 720,
      });
      expect(wideWindow.openInterestTrend?.sampleCount).toBe(2);
    });
  });

  describe("longShortRatioAtStart", () => {
    it("passes the caller-supplied snapshot through unchanged", () => {
      const snapshot = { buyRatio: new Big("0.55"), sellRatio: new Big("0.45") };
      const features = computeFundingEpisodeFeatures(baseInput({ longShortRatioAtStart: snapshot }));
      expect(features.longShortRatioAtStart).toBe(snapshot);
    });

    it("is undefined when the caller found no reading", () => {
      const features = computeFundingEpisodeFeatures(baseInput({ longShortRatioAtStart: undefined }));
      expect(features.longShortRatioAtStart).toBeUndefined();
    });
  });

  describe("recentLiquidationVolume", () => {
    it("sums base-volume per side and notional across in-window events, ignoring out-of-window ones", () => {
      const samples: LiquidationSample[] = [
        { timestampMs: EPISODE_START_MS - 30 * HOUR_MS, side: "Buy", size: new Big("999"), price: new Big("100") }, // out of window (default 24h)
        { timestampMs: EPISODE_START_MS - 10 * HOUR_MS, side: "Buy", size: new Big("2"), price: new Big("100") },
        { timestampMs: EPISODE_START_MS, side: "Sell", size: new Big("3"), price: new Big("50") },
      ];
      const features = computeFundingEpisodeFeatures(baseInput({ liquidationHistory: samples }));
      expect(features.recentLiquidationVolume.eventCount).toBe(2);
      expect(features.recentLiquidationVolume.buyVolumeBase.toString()).toBe("2");
      expect(features.recentLiquidationVolume.sellVolumeBase.toString()).toBe("3");
      expect(features.recentLiquidationVolume.notionalVolumeQuote.toString()).toBe(
        new Big("2").times("100").plus(new Big("3").times("50")).toString(),
      );
    });

    it("is always defined, reporting zero volume rather than undefined when no liquidations fall in the window", () => {
      const features = computeFundingEpisodeFeatures(baseInput({ liquidationHistory: [] }));
      expect(features.recentLiquidationVolume.eventCount).toBe(0);
      expect(features.recentLiquidationVolume.buyVolumeBase.toString()).toBe("0");
      expect(features.recentLiquidationVolume.sellVolumeBase.toString()).toBe("0");
      expect(features.recentLiquidationVolume.notionalVolumeQuote.toString()).toBe("0");
    });
  });

  describe("fundingVolatility", () => {
    it("computes mean and sample standard deviation (n-1) of r8h-normalized settled rates in the window", () => {
      // All 480min (8h) interval, so r8h == rate directly. rates: 0.0003, 0.0004, 0.0005
      // mean = 0.0004; deviations -0.0001/0/0.0001; sum of squares = 2e-8; variance (n-1=2) = 1e-8; stddev = 0.0001
      const samples: SettledFundingSample[] = [
        { fundingTimestampMs: EPISODE_START_MS - 16 * HOUR_MS, intervalMinutes: 480, rate: new Big("0.0003") },
        { fundingTimestampMs: EPISODE_START_MS - 8 * HOUR_MS, intervalMinutes: 480, rate: new Big("0.0004") },
        { fundingTimestampMs: EPISODE_START_MS - 1 * HOUR_MS, intervalMinutes: 480, rate: new Big("0.0005") },
      ];
      const features = computeFundingEpisodeFeatures(baseInput({ fundingHistory: samples }));
      expect(features.fundingVolatility).toBeDefined();
      expect(features.fundingVolatility?.sampleCount).toBe(3);
      expect(features.fundingVolatility?.meanR8h.toString()).toBe("0.0004");
      expect(features.fundingVolatility?.stdDevR8h.toString()).toBe("0.0001");
    });

    it("excludes a sample dated at or after episodeStartMs, so it never overlaps r8hAtStart's own reading", () => {
      const samples: SettledFundingSample[] = [
        { fundingTimestampMs: EPISODE_START_MS - 8 * HOUR_MS, intervalMinutes: 480, rate: new Big("0.0003") },
        { fundingTimestampMs: EPISODE_START_MS, intervalMinutes: 480, rate: new Big("0.0009") }, // excluded: not strictly before start
      ];
      const features = computeFundingEpisodeFeatures(baseInput({ fundingHistory: samples }));
      // Only one sample remains after the < episodeStartMs filter — below the 2-sample minimum.
      expect(features.fundingVolatility).toBeUndefined();
    });

    it("is undefined with fewer than two in-window samples", () => {
      const noSamples = computeFundingEpisodeFeatures(baseInput({ fundingHistory: [] }));
      expect(noSamples.fundingVolatility).toBeUndefined();

      const oneSample = computeFundingEpisodeFeatures(
        baseInput({
          fundingHistory: [{ fundingTimestampMs: EPISODE_START_MS - 1 * HOUR_MS, intervalMinutes: 480, rate: new Big("0.0003") }],
        }),
      );
      expect(oneSample.fundingVolatility).toBeUndefined();
    });

    it("normalizes each sample by its OWN interval_minutes, handling an interval change mid-window correctly", () => {
      // First sample at 240min: r8h = 0.0002 * 2 = 0.0004
      // Second sample at 480min: r8h = 0.0004 * 1 = 0.0004
      // Both normalize to the same r8h, so stddev should be exactly 0 despite the raw rates differing.
      const samples: SettledFundingSample[] = [
        { fundingTimestampMs: EPISODE_START_MS - 8 * HOUR_MS, intervalMinutes: 240, rate: new Big("0.0002") },
        { fundingTimestampMs: EPISODE_START_MS - 4 * HOUR_MS, intervalMinutes: 480, rate: new Big("0.0004") },
      ];
      const features = computeFundingEpisodeFeatures(baseInput({ fundingHistory: samples }));
      expect(features.fundingVolatility?.meanR8h.toString()).toBe("0.0004");
      expect(features.fundingVolatility?.stdDevR8h.toString()).toBe("0");
    });
  });
});
