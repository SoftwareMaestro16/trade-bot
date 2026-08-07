import Big from "big.js";
import { describe, expect, it } from "vitest";
import { NoOpVetoModel } from "../../src/predictive/vetoModel.js";
import type { FundingEpisodeFeatures } from "../../src/predictive/episodeFeatures.js";

function buildFeatures(): FundingEpisodeFeatures {
  return {
    symbol: "BTCUSDT",
    episodeStartMs: 1_700_000_000_000,
    r8hAtStart: new Big("0.0003"),
    aprAtStart: new Big("32.85"),
    openInterestTrend: undefined,
    longShortRatioAtStart: undefined,
    recentLiquidationVolume: {
      windowHours: 24,
      buyVolumeBase: new Big(0),
      sellVolumeBase: new Big(0),
      notionalVolumeQuote: new Big(0),
      eventCount: 0,
    },
    fundingVolatility: undefined,
  };
}

describe("NoOpVetoModel", () => {
  it("never vetoes — always returns false regardless of input, per its own doc comment ('нет мнения, не вмешивайся')", () => {
    const model = new NoOpVetoModel();
    expect(model.shouldVeto(buildFeatures())).toBe(false);
  });
});
