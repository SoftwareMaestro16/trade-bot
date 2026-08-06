import Big from "big.js";
import { describe, expect, it } from "vitest";
import { computeEquitySnapshot } from "../../src/emulation/equityEngine.js";
import { checkDrawdown, computeDrawdown } from "../../src/risk/drawdown.js";
import type { EquitySnapshotInput } from "../../src/emulation/equityEngine.js";

/** Baseline: no price movement since entry, no funding/borrow accrued yet, 1x leverage. */
function baseInput(overrides: Partial<EquitySnapshotInput> = {}): EquitySnapshotInput {
  return {
    spotEntryPrice: new Big("1000"),
    perpEntryPrice: new Big("995"),
    qty: new Big("1"),
    spotMarkPrice: new Big("1000"),
    perpMarkPrice: new Big("995"),
    leverage: new Big("1"),
    fundingAccrued: new Big("0"),
    borrowCostAccrued: new Big("0"),
    ...overrides,
  };
}

describe("computeEquitySnapshot — initial capital and no-movement baseline", () => {
  it("at 1x leverage with zero price movement, equity equals spot notional plus perp's full notional as margin, and unrealized P&L is zero", () => {
    const snapshot = computeEquitySnapshot(baseInput());
    // initialCapital = entryLegNotional(1000) + perpEntryNotional(995)/leverage(1) = 1995
    expect(snapshot.initialCapital.toString()).toBe("1995");
    expect(snapshot.breakdown.basisComponent.toString()).toBe("0");
    expect(snapshot.breakdown.fundingComponent.toString()).toBe("0");
    expect(snapshot.breakdown.borrowCostComponent.toString()).toBe("0");
    expect(snapshot.breakdown.total.toString()).toBe("0");
    expect(snapshot.totalEquity.toString()).toBe("1995");
  });

  it("higher leverage lowers the perp leg's initial margin, and therefore initialCapital/totalEquity, for the identical entry", () => {
    const lowLeverage = computeEquitySnapshot(baseInput({ leverage: new Big("1") }));
    const highLeverage = computeEquitySnapshot(baseInput({ leverage: new Big("5") }));
    // perpInitialMargin = 995/5 = 199; initialCapital = 1000 + 199 = 1199
    expect(highLeverage.initialCapital.toString()).toBe("1199");
    expect(highLeverage.totalEquity.toString()).toBe("1199");
    expect(highLeverage.totalEquity.lt(lowLeverage.totalEquity)).toBe(true);
  });

  it("throws RangeError on zero leverage — an impossible config value, not a market outcome", () => {
    expect(() => computeEquitySnapshot(baseInput({ leverage: new Big("0") }))).toThrow(RangeError);
  });

  it("throws RangeError on negative leverage", () => {
    expect(() => computeEquitySnapshot(baseInput({ leverage: new Big("-2") }))).toThrow(RangeError);
  });
});

describe("computeEquitySnapshot — unrealized basis P&L moves in both directions", () => {
  it("a basis that WIDENS (more discount at exit than entry) is a GAIN for short-perp/long-spot, equal notionals — matches realizedPnl.ts's own worked example", () => {
    // entryBasis=-0.0005 (perp 9995 vs spot 10000), currentBasis=-0.0015 (perp 9985 vs spot 10000 unchanged)
    const snapshot = computeEquitySnapshot(
      baseInput({
        spotEntryPrice: new Big("10000"),
        perpEntryPrice: new Big("9995"),
        spotMarkPrice: new Big("10000"),
        perpMarkPrice: new Big("9985"),
      }),
    );
    expect(snapshot.breakdown.basisComponent.toString()).toBe("10");
    expect(snapshot.breakdown.basisComponent.gt(0)).toBe(true);
  });

  it("a basis that NARROWS is a LOSS for short-perp/long-spot, equal notionals — the mirror image of the widening case", () => {
    // entryBasis=-0.0015 (perp 9985 vs spot 10000), currentBasis=-0.0005 (perp 9995 vs spot 10000 unchanged)
    const snapshot = computeEquitySnapshot(
      baseInput({
        spotEntryPrice: new Big("10000"),
        perpEntryPrice: new Big("9985"),
        spotMarkPrice: new Big("10000"),
        perpMarkPrice: new Big("9995"),
      }),
    );
    expect(snapshot.breakdown.basisComponent.toString()).toBe("-10");
    expect(snapshot.breakdown.basisComponent.lt(0)).toBe(true);
  });

  it("entry and current notionals are kept independent when the underlying price itself moves — reproduces realizedPnl.ts's exact 'entryLegNotional !== exitLegNotional' scenario with basisComponent=6", () => {
    // spot_entry=1000, perp_entry=995 -> entryBasis=-0.005
    // spot_mark=1100, perp_mark=1089 -> currentBasis=(1089-1100)/1100=-0.01
    // True combined P&L: (perp_entry-perp_mark) + (spot_mark-spot_entry) = (995-1089)+(1100-1000) = -94+100 = 6
    const snapshot = computeEquitySnapshot(
      baseInput({
        spotMarkPrice: new Big("1100"),
        perpMarkPrice: new Big("1089"),
      }),
    );
    expect(snapshot.breakdown.basisComponent.toString()).toBe("6");
    // initialCapital unaffected by mark price movement (it is fixed at entry): 1000 + 995/1 = 1995
    expect(snapshot.initialCapital.toString()).toBe("1995");
    expect(snapshot.totalEquity.toString()).toBe("2001");
  });
});

describe("computeEquitySnapshot — funding and borrow cost accrual", () => {
  it("funding accrued passes through unchanged into fundingComponent and adds directly to equity", () => {
    const snapshot = computeEquitySnapshot(baseInput({ fundingAccrued: new Big("50") }));
    expect(snapshot.breakdown.fundingComponent.toString()).toBe("50");
    expect(snapshot.breakdown.total.toString()).toBe("50");
    expect(snapshot.totalEquity.toString()).toBe("2045"); // 1995 + 50
  });

  it("a negative fundingAccrued (net paid, not received) reduces equity — the sign is passed through, not clamped", () => {
    const snapshot = computeEquitySnapshot(baseInput({ fundingAccrued: new Big("-15") }));
    expect(snapshot.breakdown.fundingComponent.toString()).toBe("-15");
    expect(snapshot.totalEquity.toString()).toBe("1980"); // 1995 - 15
  });

  it("borrow cost accrued is given as a positive cost but negated into borrowCostComponent, and subtracts from equity", () => {
    const snapshot = computeEquitySnapshot(baseInput({ borrowCostAccrued: new Big("20") }));
    expect(snapshot.breakdown.borrowCostComponent.toString()).toBe("-20");
    expect(snapshot.breakdown.borrowCostComponent.lte(0)).toBe(true);
    expect(snapshot.totalEquity.toString()).toBe("1975"); // 1995 - 20
  });

  it("full composition: basis movement, funding, and borrow cost combine into one signed total, same style as realizedPnl.ts's composition tests", () => {
    const snapshot = computeEquitySnapshot(
      baseInput({
        spotMarkPrice: new Big("1100"),
        perpMarkPrice: new Big("1089"),
        fundingAccrued: new Big("50"),
        borrowCostAccrued: new Big("5"),
      }),
    );
    // basis=6, funding=50, borrowCost=-5 -> total=51; initialCapital=1995 -> totalEquity=2046
    expect(snapshot.breakdown.total.toString()).toBe("51");
    expect(snapshot.totalEquity.toString()).toBe("2046");
    // breakdown components must sum to `total`, and initialCapital + total must equal totalEquity —
    // internal consistency, not just individually-correct numbers.
    const sumOfComponents = snapshot.breakdown.fundingComponent
      .plus(snapshot.breakdown.basisComponent)
      .plus(snapshot.breakdown.borrowCostComponent);
    expect(sumOfComponents.toString()).toBe(snapshot.breakdown.total.toString());
    expect(snapshot.initialCapital.plus(snapshot.breakdown.total).toString()).toBe(
      snapshot.totalEquity.toString(),
    );
  });
});

describe("computeEquitySnapshot — equity at and beyond a hypothetical liquidation-magnitude move", () => {
  it("returns EXACTLY zero equity without throwing, when the adverse move exactly consumes initialCapital", () => {
    // entryBasis=0 (spot=perp=1000 at entry), leverage=10 -> perpInitialMargin=100,
    // initialCapital = 1000 + 100 = 1100. Spot mark unchanged at 1000 (currentLegNotional=1000).
    // Solve for the perp mark that drives basisComponent to exactly -1100:
    // basisComponent = 0*1000 - currentBasis*1000 = -1100 -> currentBasis=1.1 -> perpMark=2100.
    const snapshot = computeEquitySnapshot({
      spotEntryPrice: new Big("1000"),
      perpEntryPrice: new Big("1000"),
      qty: new Big("1"),
      spotMarkPrice: new Big("1000"),
      perpMarkPrice: new Big("2100"),
      leverage: new Big("10"),
      fundingAccrued: new Big("0"),
      borrowCostAccrued: new Big("0"),
    });
    expect(snapshot.initialCapital.toString()).toBe("1100");
    expect(snapshot.totalEquity.toString()).toBe("0");
  });

  it("returns a NEGATIVE equity without throwing, when the adverse move exceeds initialCapital — the real liquidation-magnitude case risk/leverage.ts's checkLeverage wrongly assumed 'cannot happen'", () => {
    const snapshot = computeEquitySnapshot({
      spotEntryPrice: new Big("1000"),
      perpEntryPrice: new Big("1000"),
      qty: new Big("1"),
      spotMarkPrice: new Big("1000"),
      perpMarkPrice: new Big("2200"), // currentBasis=1.2 -> basisComponent=-1200
      leverage: new Big("10"),
      fundingAccrued: new Big("0"),
      borrowCostAccrued: new Big("0"),
    });
    expect(snapshot.totalEquity.toString()).toBe("-100"); // 1100 - 1200
    expect(snapshot.totalEquity.lt(0)).toBe(true);
  });

  it("negative equity plus a heavy borrow cost accrual composes without throwing (both loss sources stack)", () => {
    const snapshot = computeEquitySnapshot({
      spotEntryPrice: new Big("1000"),
      perpEntryPrice: new Big("1000"),
      qty: new Big("1"),
      spotMarkPrice: new Big("1000"),
      perpMarkPrice: new Big("2200"),
      leverage: new Big("10"),
      fundingAccrued: new Big("0"),
      borrowCostAccrued: new Big("30"),
    });
    expect(snapshot.totalEquity.toString()).toBe("-130"); // -100 - 30
  });
});

describe("computeEquitySnapshot output feeds risk/drawdown.ts directly, no adapter", () => {
  it("totalEquity from a healthy snapshot and a liquidation-magnitude snapshot both plug straight into computeDrawdown/checkDrawdown as `currentEquity`", () => {
    const peakSnapshot = computeEquitySnapshot({
      spotEntryPrice: new Big("1000"),
      perpEntryPrice: new Big("1000"),
      qty: new Big("1"),
      spotMarkPrice: new Big("1000"),
      perpMarkPrice: new Big("1000"),
      leverage: new Big("10"),
      fundingAccrued: new Big("0"),
      borrowCostAccrued: new Big("0"),
    });
    const peakEquity = peakSnapshot.totalEquity; // 1100

    const zeroedSnapshot = computeEquitySnapshot({
      spotEntryPrice: new Big("1000"),
      perpEntryPrice: new Big("1000"),
      qty: new Big("1"),
      spotMarkPrice: new Big("1000"),
      perpMarkPrice: new Big("2100"),
      leverage: new Big("10"),
      fundingAccrued: new Big("0"),
      borrowCostAccrued: new Big("0"),
    });
    // No conversion, no wrapping — the Big returned by computeEquitySnapshot is passed as-is.
    expect(computeDrawdown(zeroedSnapshot.totalEquity, peakEquity).toString()).toBe("1");
    expect(checkDrawdown(zeroedSnapshot.totalEquity, peakEquity)).toMatchObject({
      allowed: false,
      code: "DRAWDOWN_EXCEEDED",
    });

    const negativeSnapshot = computeEquitySnapshot({
      spotEntryPrice: new Big("1000"),
      perpEntryPrice: new Big("1000"),
      qty: new Big("1"),
      spotMarkPrice: new Big("1000"),
      perpMarkPrice: new Big("2200"),
      leverage: new Big("10"),
      fundingAccrued: new Big("0"),
      borrowCostAccrued: new Big("0"),
    });
    // Negative equity must not throw when handed to computeDrawdown/checkDrawdown either —
    // unlike risk/leverage.ts's checkLeverage, drawdown.ts's own contract never assumed
    // currentEquity > 0, so this is the intended, adapter-free usage.
    expect(() => computeDrawdown(negativeSnapshot.totalEquity, peakEquity)).not.toThrow();
    const drawdown = computeDrawdown(negativeSnapshot.totalEquity, peakEquity);
    expect(drawdown.gt(1)).toBe(true); // (1100 - (-100)) / 1100 > 1
    expect(checkDrawdown(negativeSnapshot.totalEquity, peakEquity).allowed).toBe(false);
  });
});
