import Big from "big.js";
import { describe, expect, it, vi } from "vitest";
import { episodeToCsvRow, resolveSymbols } from "../../src/scripts/exportPredictiveTrainingDataset.js";
import type { LabeledFundingEpisode } from "../../src/predictive/episodeExtraction.js";

/**
 * Pure-function tests only — no DB required, same shape as
 * test/scripts/runEmulationScenario.test.ts. csvEscape's own quote/comma/
 * newline behavior is NOT re-tested here: this file delegates to
 * reportGenerator.ts's csvEscapeField, which already has its own coverage in
 * test/emulation/reportGenerator.test.ts.
 */

// recentLiquidationVolume is unconditionally defined on FundingEpisodeFeatures
// (see episodeFeatures.ts's own doc comment on that field), so every fixture
// below carries one regardless of which optional fields it sets.
const baseLiq = {
  windowHours: 24,
  buyVolumeBase: new Big("1.5"),
  sellVolumeBase: new Big("2.5"),
  notionalVolumeQuote: new Big("4000"),
  eventCount: 3,
};

function buildEpisode(overrides: {
  openInterestTrend?: LabeledFundingEpisode["features"]["openInterestTrend"];
  longShortRatioAtStart?: LabeledFundingEpisode["features"]["longShortRatioAtStart"];
  fundingVolatility?: LabeledFundingEpisode["features"]["fundingVolatility"];
}): LabeledFundingEpisode {
  return {
    symbol: "BTCUSDT",
    episodeStartMs: 1_700_000_000_000,
    label: true,
    labelWindowHours: 72,
    features: {
      symbol: "BTCUSDT",
      episodeStartMs: 1_700_000_000_000,
      r8hAtStart: new Big("0.0003"),
      aprAtStart: new Big("32.85"),
      openInterestTrend: overrides.openInterestTrend,
      longShortRatioAtStart: overrides.longShortRatioAtStart,
      recentLiquidationVolume: baseLiq,
      fundingVolatility: overrides.fundingVolatility,
    },
  };
}

describe("episodeToCsvRow", () => {
  it("serializes a fully-populated episode's oi/ls/vol fields as their real values, in CSV_HEADER order", () => {
    const episode = buildEpisode({
      openInterestTrend: {
        windowHours: 24,
        direction: "up",
        changePercent: new Big("12.5"),
        earliestOpenInterest: new Big("1000"),
        latestOpenInterest: new Big("1125"),
        sampleCount: 6,
      },
      longShortRatioAtStart: { buyRatio: new Big("0.6"), sellRatio: new Big("0.4") },
      fundingVolatility: {
        windowHours: 720,
        sampleCount: 90,
        meanR8h: new Big("0.00025"),
        stdDevR8h: new Big("0.00004"),
      },
    });

    expect(episodeToCsvRow(episode)).toEqual([
      "BTCUSDT",
      "1700000000000",
      "true",
      "72",
      "0.0003",
      "32.85",
      "24",
      "up",
      "12.5",
      "6",
      "0.6",
      "0.4",
      "24",
      "1.5",
      "2.5",
      "4000",
      "3",
      "720",
      "90",
      "0.00025",
      "0.00004",
    ]);
  });

  it("serializes undefined oi/ls/vol as empty-string fields while the unconditional liq fields stay populated", () => {
    const episode = buildEpisode({
      openInterestTrend: undefined,
      longShortRatioAtStart: undefined,
      fundingVolatility: undefined,
    });

    const row = episodeToCsvRow(episode);

    // oi_trend_window_hours, oi_trend_direction, oi_trend_change_percent, oi_trend_sample_count
    expect(row.slice(6, 10)).toEqual(["", "", "", ""]);
    // ls_ratio_buy, ls_ratio_sell
    expect(row.slice(10, 12)).toEqual(["", ""]);
    // liq_window_hours .. liq_event_count — unconditionally populated, unaffected by the oi/ls/vol gaps above
    expect(row.slice(12, 17)).toEqual(["24", "1.5", "2.5", "4000", "3"]);
    // funding_vol_window_hours, funding_vol_sample_count, funding_vol_mean_r8h, funding_vol_stddev_r8h
    expect(row.slice(17, 21)).toEqual(["", "", "", ""]);
  });
});

describe("resolveSymbols", () => {
  it("overrides configuredSymbols with a parsed, trimmed, non-empty-filtered argv list, without consulting the DB fallback", async () => {
    const fetchKnownSymbols = vi.fn(async () => ["SHOULD_NOT_BE_USED"]);
    const symbols = await resolveSymbols(" BTCUSDT ,ETHUSDT,, SOLUSDT", ["CONFIGURED"], fetchKnownSymbols);
    expect(symbols).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(fetchKnownSymbols).not.toHaveBeenCalled();
  });

  it("falls back to the configured SYMBOLS const when no argv override is given, without consulting the DB fallback", async () => {
    const fetchKnownSymbols = vi.fn(async () => ["SHOULD_NOT_BE_USED"]);
    const symbols = await resolveSymbols(undefined, ["BTCUSDT", "ETHUSDT"], fetchKnownSymbols);
    expect(symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(fetchKnownSymbols).not.toHaveBeenCalled();
  });

  it("treats an empty-string argv override the same as no override (falls through to configuredSymbols)", async () => {
    const fetchKnownSymbols = vi.fn(async () => ["SHOULD_NOT_BE_USED"]);
    const symbols = await resolveSymbols("", ["BTCUSDT"], fetchKnownSymbols);
    expect(symbols).toEqual(["BTCUSDT"]);
    expect(fetchKnownSymbols).not.toHaveBeenCalled();
  });

  it("falls back to fetchKnownSymbols (listKnownSymbols(db)) when neither argv nor SYMBOLS const provide a list", async () => {
    const fetchKnownSymbols = vi.fn(async () => ["BTCUSDT", "ETHUSDT"]);
    const symbols = await resolveSymbols(undefined, [], fetchKnownSymbols);
    expect(symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(fetchKnownSymbols).toHaveBeenCalledTimes(1);
  });
});
