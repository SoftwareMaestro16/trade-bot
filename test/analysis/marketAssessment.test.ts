import Big from "big.js";
import { describe, expect, it } from "vitest";
import { assessMarket } from "../../src/analysis/marketAssessment.js";
import type { SymbolMarketStat } from "../../src/analysis/marketAssessment.js";

// A pair clearing all three conditions: deep books, real premium-driven
// funding, and a basis calm enough that the 0.5% stop is 50 sigma away.
const OPPORTUNITY: SymbolMarketStat = {
  symbol: "GOODUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.001"), // 0.1%/8h
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.0001"),
};

// Liquid and calm, like BTC/ETH, but funding pinned near the clamp — fails the
// premium-driven gate.
const CALM_MAJOR: SymbolMarketStat = {
  symbol: "BTCUSDT",
  perpTurnover24h: new Big("2500000000"),
  spotTurnover24h: new Big("300000000"),
  predictedR8h: new Big("0.0001"), // 0.01%/8h, below the 0.05% premium bar
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.000067"),
};

// Liquid and funded, but a basis so volatile the stop sits under 3 sigma away —
// the "looks great, gets stopped out before the first settlement" trap.
const FUNDED_BUT_VOLATILE: SymbolMarketStat = {
  symbol: "WILDUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.002"),
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.003"), // room 0.005 / 0.003 = 1.67 sigma
};

describe("assessMarket — condition classification matches the vetoes", () => {
  it("flags a pair clearing all three as an opportunity", () => {
    const a = assessMarket([OPPORTUNITY]);
    expect(a.opportunities.map((o) => o.symbol)).toEqual(["GOODUSDT"]);
    const c = a.classifications[0]!;
    expect(c.passesLiquidity).toBe(true);
    expect(c.passesFunding).toBe(true);
    expect(c.passesBasisStability).toBe(true);
    expect(c.isOpportunity).toBe(true);
  });

  it("rejects a calm major on funding, and counts it as liquid-but-unfunded", () => {
    const a = assessMarket([CALM_MAJOR]);
    expect(a.opportunities).toHaveLength(0);
    expect(a.liquidButUnfunded).toBe(1);
    expect(a.classifications[0]!.passesFunding).toBe(false);
    expect(a.classifications[0]!.passesBasisStability).toBe(true);
  });

  it("rejects a funded-but-volatile pair on basis stability, and counts it", () => {
    const a = assessMarket([FUNDED_BUT_VOLATILE]);
    expect(a.opportunities).toHaveLength(0);
    expect(a.fundedButVolatile).toBe(1);
    const c = a.classifications[0]!;
    expect(c.passesFunding).toBe(true);
    expect(c.passesBasisStability).toBe(false);
    expect(c.sigmasToStop!.toFixed(2)).toBe("1.67");
  });

  it("treats unknown basis volatility as failing stability, never as calm", () => {
    const a = assessMarket([{ ...OPPORTUNITY, basisStdDev: null }]);
    expect(a.opportunities).toHaveLength(0);
    expect(a.classifications[0]!.passesBasisStability).toBe(false);
    expect(a.classifications[0]!.sigmasToStop).toBeNull();
  });

  it("fails stability with zero remaining room when the basis already sits at the stop", () => {
    const a = assessMarket([{ ...OPPORTUNITY, currentBasis: new Big("0.006") }]);
    expect(a.classifications[0]!.passesBasisStability).toBe(false);
    expect(a.classifications[0]!.sigmasToStop!.toString()).toBe("0");
  });
});

describe("assessMarket — suitability score is honest about an empty market", () => {
  it("scores zero and 'unsuitable' when nothing is tradeable (the current real state)", () => {
    const a = assessMarket([CALM_MAJOR, FUNDED_BUT_VOLATILE]);
    expect(a.suitabilityScore).toBe(0);
    expect(a.suitability).toBe("unsuitable");
  });

  it("scores an empty universe at zero rather than throwing", () => {
    const a = assessMarket([]);
    expect(a.scannedSymbols).toBe(0);
    expect(a.suitabilityScore).toBe(0);
    expect(a.suitability).toBe("unsuitable");
  });

  it("rises above zero once a real opportunity exists", () => {
    const a = assessMarket([CALM_MAJOR, OPPORTUNITY]);
    expect(a.suitabilityScore).toBeGreaterThan(0);
    expect(["marginal", "favorable", "strong"]).toContain(a.suitability);
  });

  it("saturates near 100 for a very high sustained funding rate", () => {
    const rich: SymbolMarketStat = { ...OPPORTUNITY, predictedR8h: new Big("0.002") }; // 0.2%/8h
    // 0.002 * 0.65 * 90 * 100 = 11.7% ceiling -> clamps to 100.
    expect(assessMarket([rich]).suitabilityScore).toBe(100);
  });

  it("gives a bounded bonus for multiple opportunities, never turning weak into strong", () => {
    // Two weak-but-real opportunities: funding just over the premium bar.
    const weak: SymbolMarketStat = { ...OPPORTUNITY, predictedR8h: new Big("0.00051") };
    const single = assessMarket([weak]).suitabilityScore;
    const pair = assessMarket([weak, { ...weak, symbol: "GOOD2USDT" }]).suitabilityScore;
    expect(pair).toBeGreaterThan(single);
    expect(pair - single).toBeLessThanOrEqual(15);
  });
});

describe("assessMarket — the month-scale figure is a ceiling", () => {
  it("computes gross monthly ceiling as r8h * 0.65 * 90 settlements", () => {
    // 0.001 * 0.65 * 90 * 100 = 5.85%.
    expect(assessMarket([OPPORTUNITY]).classifications[0]!.grossMonthlyCeilingPct.toFixed(2)).toBe("5.85");
  });
});
