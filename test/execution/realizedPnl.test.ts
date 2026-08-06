import Big from "big.js";
import { describe, expect, it } from "vitest";
import { computeRealizedPnl, computeRealizedPnlBreakdown } from "../../src/execution/realizedPnl.js";

describe("computeRealizedPnl — basis term sign convention", () => {
  it("matches RISK-REGISTER.md FM-06's own worked example exactly: entry −9.6bp, exit 0bp, on $10,000 notional is a $9.60 loss (0.096% of notional)", () => {
    const pnl = computeRealizedPnl({
      entryLegNotional: new Big("10000"),
      exitLegNotional: new Big("10000"),
      entryBasis: new Big("-0.00096"),
      exitBasis: new Big("0"),
      grossFundingCollected: new Big("0"),
      totalFees: new Big("0"),
      realizedSlippage: new Big("0"),
    });
    expect(pnl.toString()).toBe("-9.6");
  });

  it("a basis that WIDENS (more discount at exit than entry) is a GAIN for the short-perp/long-spot combination, when entry/exit notional happen to be equal", () => {
    // Shorted the perp at a small discount (-5bp); by exit it fell further
    // relative to spot (-15bp) — favorable direction for the short leg.
    const pnl = computeRealizedPnl({
      entryLegNotional: new Big("10000"),
      exitLegNotional: new Big("10000"),
      entryBasis: new Big("-0.0005"),
      exitBasis: new Big("-0.0015"),
      grossFundingCollected: new Big("0"),
      totalFees: new Big("0"),
      realizedSlippage: new Big("0"),
    });
    expect(pnl.toString()).toBe("10"); // (−0.0005 × 10000) − (−0.0015 × 10000) = −5 − (−15) = 10
    expect(pnl.gt(0)).toBe(true);
  });

  it("zero basis movement contributes exactly zero, regardless of the absolute level", () => {
    const pnl = computeRealizedPnl({
      entryLegNotional: new Big("10000"),
      exitLegNotional: new Big("10000"),
      entryBasis: new Big("-0.002"),
      exitBasis: new Big("-0.002"),
      grossFundingCollected: new Big("0"),
      totalFees: new Big("0"),
      realizedSlippage: new Big("0"),
    });
    expect(pnl.toString()).toBe("0");
  });
});

describe("computeRealizedPnl — entry and exit notional are independent (the underlying price moves between entry and exit)", () => {
  it("uses entryBasis × entryLegNotional MINUS exitBasis × exitLegNotional — collapsing to one shared notional silently mis-states P&L the moment they differ", () => {
    // q=1 unit throughout (no rebalancing). spot_entry=1000, perp_entry=995
    // -> entryBasis=(995-1000)/1000=-0.005. spot_exit=1100, perp_exit=1089
    // -> exitBasis=(1089-1100)/1100=-0.01.
    // True P&L (bedrock: short-perp profit + long-spot profit):
    //   q×(perp_entry−perp_exit) + q×(spot_exit−spot_entry)
    //   = (995−1089) + (1100−1000) = −94 + 100 = 6
    // The old, buggy single-notional formula — (entryBasis−exitBasis)×entryLegNotional
    // = (−0.005−(−0.01))×1000 = 5 — is WRONG here (off by 1, a real dollar
    // error): it implicitly assumes exitLegNotional also equals 1000, when
    // the real exit-time notional (q×spot_exit) is 1100.
    const pnl = computeRealizedPnl({
      entryLegNotional: new Big("1000"),
      exitLegNotional: new Big("1100"),
      entryBasis: new Big("-0.005"),
      exitBasis: new Big("-0.01"),
      grossFundingCollected: new Big("0"),
      totalFees: new Big("0"),
      realizedSlippage: new Big("0"),
    });
    expect(pnl.toString()).toBe("6");
  });
});

describe("computeRealizedPnl — full composition", () => {
  it("combines funding, basis, fees, and slippage into one signed total", () => {
    const pnl = computeRealizedPnl({
      entryLegNotional: new Big("10000"),
      exitLegNotional: new Big("10000"),
      entryBasis: new Big("-0.0002"), // -2bp
      exitBasis: new Big("-0.0001"), // -1bp (narrowed 1bp -> -1 basis cost)
      grossFundingCollected: new Big("50"), // $50 collected
      totalFees: new Big("31"), // 0.31% round-trip on $10,000 = $31 (PARAMS-CONSERVATIVE.md §6)
      realizedSlippage: new Big("5"),
    });
    // basis: (-0.0002 * 10000) - (-0.0001 * 10000) = -2 - (-1) = -1
    // total: 50 + (-1) - 31 - 5 = 13
    expect(pnl.toString()).toBe("13");
  });

  it("can be net negative even with positive funding collected, if fees/basis/slippage exceed it", () => {
    const pnl = computeRealizedPnl({
      entryLegNotional: new Big("10000"),
      exitLegNotional: new Big("10000"),
      entryBasis: new Big("-0.001"),
      exitBasis: new Big("0"),
      grossFundingCollected: new Big("5"), // small funding collected
      totalFees: new Big("31"),
      realizedSlippage: new Big("5"),
    });
    // basis: (-0.001 * 10000) - (0 * 10000) = -10
    // total: 5 + (-10) - 31 - 5 = -41
    expect(pnl.toString()).toBe("-41");
    expect(pnl.lt(0)).toBe(true);
  });
});

describe("computeRealizedPnlBreakdown", () => {
  it("returns every term separately, and the terms sum to the same total computeRealizedPnl returns", () => {
    const input = {
      entryLegNotional: new Big("10000"),
      exitLegNotional: new Big("10000"),
      entryBasis: new Big("-0.0002"),
      exitBasis: new Big("-0.0001"),
      grossFundingCollected: new Big("50"),
      totalFees: new Big("31"),
      realizedSlippage: new Big("5"),
    };

    const breakdown = computeRealizedPnlBreakdown(input);
    const directTotal = computeRealizedPnl(input);

    expect(breakdown.fundingComponent.toString()).toBe("50");
    expect(breakdown.basisComponent.toString()).toBe("-1");
    expect(breakdown.feesComponent.toString()).toBe("-31");
    expect(breakdown.slippageComponent.toString()).toBe("-5");
    expect(breakdown.total.toString()).toBe(directTotal.toString());
    expect(breakdown.total.toString()).toBe("13");
  });

  it("fees and slippage components are always non-positive, even though the input is given as a positive cost", () => {
    const breakdown = computeRealizedPnlBreakdown({
      entryLegNotional: new Big("1000"),
      exitLegNotional: new Big("1000"),
      entryBasis: new Big("0"),
      exitBasis: new Big("0"),
      grossFundingCollected: new Big("0"),
      totalFees: new Big("3.1"),
      realizedSlippage: new Big("0.5"),
    });
    expect(breakdown.feesComponent.lte(0)).toBe(true);
    expect(breakdown.slippageComponent.lte(0)).toBe(true);
  });

  it("basisComponent uses the same independent entry/exit notional formula as computeRealizedPnl", () => {
    const breakdown = computeRealizedPnlBreakdown({
      entryLegNotional: new Big("1000"),
      exitLegNotional: new Big("1100"),
      entryBasis: new Big("-0.005"),
      exitBasis: new Big("-0.01"),
      grossFundingCollected: new Big("0"),
      totalFees: new Big("0"),
      realizedSlippage: new Big("0"),
    });
    expect(breakdown.basisComponent.toString()).toBe("6");
    expect(breakdown.total.toString()).toBe("6");
  });
});
