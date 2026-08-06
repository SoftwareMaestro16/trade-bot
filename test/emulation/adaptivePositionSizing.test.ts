import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  computeNextPositionSizeFraction,
  MAX_FRACTION,
  MIN_FRACTION,
  NO_HISTORY_FRACTION,
  STEP,
} from "../../src/emulation/adaptivePositionSizing.js";
import type { TradeOutcome } from "../../src/emulation/adaptivePositionSizing.js";

function trade(realizedPnl: string, equityAtClose: string): TradeOutcome {
  return { realizedPnl: new Big(realizedPnl), equityAtClose: new Big(equityAtClose) };
}

describe("computeNextPositionSizeFraction", () => {
  it("uses NO_HISTORY_FRACTION for the very first trade — no track record", () => {
    expect(computeNextPositionSizeFraction([]).toString()).toBe(NO_HISTORY_FRACTION.toString());
  });

  it("does not move on a single ordinary (non-significant) loss", () => {
    // -1% of equity — below the 3% "significant" bar.
    const fraction = computeNextPositionSizeFraction([trade("-5", "500")]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.toString());
  });

  it("steps DOWN by STEP after a single significant loss (owner: 'до этого были потери и они существенные')", () => {
    // -4% of equity — above the 3% bar.
    const fraction = computeNextPositionSizeFraction([trade("-20", "500")]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.minus(STEP).toString());
  });

  it("never steps below MIN_FRACTION regardless of losing-streak length", () => {
    const longLosingStreak: TradeOutcome[] = Array.from({ length: 10 }, () => trade("-50", "500"));
    const fraction = computeNextPositionSizeFraction(longLosingStreak);
    expect(fraction.toString()).toBe(MIN_FRACTION.toString());
  });

  it("does not move on a single isolated win — only a run counts (owner: 'если за спиной прибыль')", () => {
    const fraction = computeNextPositionSizeFraction([trade("10", "510")]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.toString());
  });

  it("steps UP by STEP after two consecutive wins", () => {
    const fraction = computeNextPositionSizeFraction([trade("10", "510"), trade("10", "520")]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.plus(STEP).toString());
  });

  it("keeps stepping up on a sustained win streak, capped at MAX_FRACTION which equals the 25% concentration ceiling", () => {
    const longWinStreak: TradeOutcome[] = Array.from({ length: 10 }, (_, i) => trade("10", String(510 + i * 10)));
    const fraction = computeNextPositionSizeFraction(longWinStreak);
    expect(fraction.toString()).toBe(MAX_FRACTION.toString());
    expect(MAX_FRACTION.toString()).toBe("0.25"); // pinned: must match PARAMS-CONSERVATIVE.md §11 exactly
  });

  it("a win streak broken by a loss resets the 'two in a row' requirement — no further step-up until two NEW consecutive wins", () => {
    // win, win (steps up once), loss (ordinary, no step), win (isolated after the break, no step)
    const fraction = computeNextPositionSizeFraction([
      trade("10", "510"),
      trade("10", "520"),
      trade("-5", "515"),
      trade("10", "525"),
    ]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.plus(STEP).toString());
  });

  it("treats a wiped-out or negative equity-at-close as a step-down, never as neutral or up (fail-closed)", () => {
    const fraction = computeNextPositionSizeFraction([trade("-500", "0")]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.minus(STEP).toString());
  });

  it("a breakeven trade (exactly zero P&L) does not move the fraction", () => {
    const fraction = computeNextPositionSizeFraction([trade("0", "500")]);
    expect(fraction.toString()).toBe(NO_HISTORY_FRACTION.toString());
  });
});
