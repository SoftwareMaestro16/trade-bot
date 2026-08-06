import Big from "big.js";
import { describe, expect, it } from "vitest";
import { checkEntry } from "../../src/risk/index.js";
import type { EntryCheckInput } from "../../src/risk/index.js";
import { checkConcentration } from "../../src/risk/leverage.js";
import { sizePosition } from "../../src/strategy/sizing.js";

// A deliberately deep, flat-priced book: any realistic targetNotional in these
// tests fills entirely at the best price, so slippage is always zero here —
// slippage's own boundary behaviour is risk/liquidity.test.ts's job, not this
// composition test's.
const deepBook = [{ price: new Big("100"), qty: new Big("1000000") }];

function goldenInput(): EntryCheckInput {
  return {
    projectedShortNotional: new Big("1000"),
    projectedSpotLegNotional: new Big("1000"),
    totalEquity: new Big("10000"),
    projectedAccountMMRate: new Big("0.05"),

    perpTurnover24h: new Big("200000000"),
    spotTurnover24h: new Big("50000000"),
    perpBids: deepBook,
    spotAsks: deepBook,
    targetNotional: new Big("1000"),

    premiumIndexR8h: new Big("0.001"),
    r8h: new Big("0.001"),
    expectedHoldIntervals: new Big("10"),
    totalRoundTripCost: new Big("0.003"),
    borrowCost8h: new Big("0"),

    nowMs: 1_000_000,
    nextFundingTimeMs: 1_000_000 + 10_000_000,

    isInnovationOrAdventureZone: false,
  };
}

describe("checkEntry — composition of all risk/ vetoes", () => {
  it("allows when every individual check passes (the golden path)", () => {
    const result = checkEntry(goldenInput());
    expect(result.allowed).toBe(true);
  });

  it("denies on zone exclusion before evaluating anything else", () => {
    const result = checkEntry({ ...goldenInput(), isInnovationOrAdventureZone: true });
    expect(result).toMatchObject({ allowed: false, code: "ZONE_EXCLUDED" });
  });

  it("denies on insufficient perp turnover", () => {
    const result = checkEntry({ ...goldenInput(), perpTurnover24h: new Big("1") });
    expect(result).toMatchObject({ allowed: false, code: "PERP_TURNOVER_TOO_LOW" });
  });

  it("denies on insufficient spot turnover", () => {
    const result = checkEntry({ ...goldenInput(), spotTurnover24h: new Big("1") });
    expect(result).toMatchObject({ allowed: false, code: "SPOT_TURNOVER_TOO_LOW" });
  });

  it("denies when the funding rate is not premium-driven (FM-01)", () => {
    const result = checkEntry({ ...goldenInput(), premiumIndexR8h: new Big("0.00001") });
    expect(result).toMatchObject({ allowed: false, code: "FUNDING_RATE_NOT_PREMIUM_DRIVEN" });
  });

  it("denies below the entry floor even when premium-driven and turnover is fine", () => {
    const result = checkEntry({
      ...goldenInput(),
      r8h: new Big("0.0001"),
      premiumIndexR8h: new Big("0.001"), // still premium-driven, so this isolates the floor check
    });
    expect(result).toMatchObject({ allowed: false, code: "FUNDING_RATE_BELOW_FLOOR" });
  });

  it("denies when net-of-borrow-cost funding falls below the floor, even though raw r8h clears it (RR-25a)", () => {
    const result = checkEntry({
      ...goldenInput(),
      r8h: new Big("0.001"), // clears ENTRY_FLOOR_R8H and the gross-multiplier check alone
      borrowCost8h: new Big("0.0009"), // net = 0.0001, below the 0.0002 floor
    });
    expect(result).toMatchObject({ allowed: false, code: "NET_FUNDING_RATE_BELOW_FLOOR" });
  });

  it("denies inside the funding settlement blackout window", () => {
    const result = checkEntry({ ...goldenInput(), nextFundingTimeMs: 1_000_000 + 30_000 });
    expect(result).toMatchObject({ allowed: false, code: "FUNDING_SETTLEMENT_BLACKOUT" });
  });

  it("denies when the perp book cannot absorb the target notional", () => {
    const result = checkEntry({ ...goldenInput(), perpBids: [] });
    expect(result).toMatchObject({ allowed: false, code: "ORDERBOOK_DEPTH_EXHAUSTED" });
  });

  it("perp slippage is measured against BIDS, not asks — the short entry sells into the bid side, so a thin bid side must deny even with deep asks", () => {
    const result = checkEntry({ ...goldenInput(), perpBids: [] }); // asks (not part of this input) stay deep via goldenInput's default
    expect(result).toMatchObject({ allowed: false, code: "ORDERBOOK_DEPTH_EXHAUSTED" });
  });

  it("denies when the spot book cannot absorb the target notional", () => {
    const result = checkEntry({ ...goldenInput(), spotAsks: [] });
    expect(result).toMatchObject({ allowed: false, code: "ORDERBOOK_DEPTH_EXHAUSTED" });
  });

  it("denies on excessive leverage", () => {
    const result = checkEntry({ ...goldenInput(), projectedShortNotional: new Big("20000") }); // 20000/10000 = 2x > 1.5x
    expect(result).toMatchObject({ allowed: false, code: "LEVERAGE_EXCEEDED" });
  });

  it("denies on excessive single-coin concentration", () => {
    const result = checkEntry({ ...goldenInput(), projectedSpotLegNotional: new Big("3000") }); // 3000/10000 = 30% > 25%
    expect(result).toMatchObject({ allowed: false, code: "CONCENTRATION_EXCEEDED" });
  });

  it("denies when projected accountMMRate reaches the liquidation-risk ceiling", () => {
    const result = checkEntry({ ...goldenInput(), projectedAccountMMRate: new Big("0.30") });
    expect(result).toMatchObject({ allowed: false, code: "ACCOUNT_MMR_EXCEEDED" });
  });
});

/**
 * TEST-CASES.md #50: "снапшот tickers+instruments, символы ниже порога
 * ликвидности отклонены на стадии скрининга... итоговый набор при пороге
 * может быть пуст — это допустимый корректный ответ (FM-07, AR-10)."
 *
 * There is no separate "screen a candidate list" function to test — per
 * strategy/rankCandidates.ts's own doc comment, filtering is deliberately
 * NOT its job ("every veto lives in risk/, this only sorts"). Screening a
 * batch is just calling the already-tested, already-composed checkEntry
 * once per candidate — this describe block proves that composition behaves
 * correctly across a realistic multi-symbol snapshot, including the
 * empty-survivor-set case, not a new src/ module.
 */
describe("checkEntry applied across a frozen multi-symbol snapshot (TEST-CASES.md #50)", () => {
  // A small, hand-frozen "snapshot" — five symbols, each failing (or passing)
  // for a DIFFERENT documented reason, mirroring what a real tickers+instruments
  // pull would actually contain: most candidates fail screening for mundane,
  // unrelated reasons, not some contrived uniform cutoff.
  const snapshot: Record<string, EntryCheckInput> = {
    GOODUSDT: goldenInput(), // survives everything — the control
    THINUSDT: { ...goldenInput(), perpTurnover24h: new Big("1000") }, // FM-07: illiquid, screened on turnover
    PINNEDUSDT: { ...goldenInput(), premiumIndexR8h: new Big("0.00001") }, // FM-01: rate sits at the clamp, not premium-driven
    BELOWFLOORUSDT: { ...goldenInput(), r8h: new Big("0.0001") }, // below the 0.020%/8h entry floor
    ZONEDUSDT: { ...goldenInput(), isInnovationOrAdventureZone: true }, // Innovation/Adventure Zone, excluded outright
  };

  function screen(candidates: Record<string, EntryCheckInput>): string[] {
    return Object.entries(candidates)
      .filter(([, input]) => checkEntry(input).allowed)
      .map(([symbol]) => symbol);
  }

  it("keeps only the symbol that clears every check, rejecting each of the others for its own distinct reason", () => {
    const survivors = screen(snapshot);
    expect(survivors).toEqual(["GOODUSDT"]);

    // Confirm each reject is for the reason the fixture actually set up —
    // not coincidentally correct because of composition order.
    expect(checkEntry(snapshot.THINUSDT!)).toMatchObject({ code: "PERP_TURNOVER_TOO_LOW" });
    expect(checkEntry(snapshot.PINNEDUSDT!)).toMatchObject({ code: "FUNDING_RATE_NOT_PREMIUM_DRIVEN" });
    expect(checkEntry(snapshot.BELOWFLOORUSDT!)).toMatchObject({ code: "FUNDING_RATE_BELOW_FLOOR" });
    expect(checkEntry(snapshot.ZONEDUSDT!)).toMatchObject({ code: "ZONE_EXCLUDED" });
  });

  it("an empty survivor set is itself a valid, correct outcome (FM-07/AR-10) — not an error, not something that needs a fallback candidate", () => {
    const { GOODUSDT: _survivor, ...onlyRejects } = snapshot;
    void _survivor;
    const survivors = screen(onlyRejects);
    expect(survivors).toEqual([]);
  });
});

/**
 * TEST-CASES.md #63: "позиция размером ровно на границе 25% капитала по
 * номиналу спотовой ноги... вход на границе принят, вход на один минимальный
 * шаг лота выше отклонён (RR-21)."
 *
 * risk/index.test.ts's own "denies on excessive single-coin concentration"
 * case above uses an arbitrary decimal ($3000 vs a $10000×25%=$2500 cap) —
 * real, not a notional any lot-step-quantized position could actually land
 * on. This composes sizePosition's REAL rounding with checkConcentration's
 * boundary, so "one lot step above" means an actual achievable position
 * size, not a hand-picked epsilon.
 */
describe("checkConcentration composed with sizePosition's real lot-step rounding (TEST-CASES.md #63)", () => {
  const totalEquity = new Big("10000"); // 25% cap = $2500
  // markPrice=1, qtyStep=1 -> one lot step is exactly $1 of notional, and
  // residualDeltaFraction = (qtyStep/2 * price) / targetNotional = 0.5/2500
  // = 0.02% at this notional, comfortably inside sizePosition's own 0.5%
  // default cap (RISK-REGISTER.md FM-12) — a $100-per-lot symbol (e.g. a
  // BTC-like qtyStep) would itself get vetoed by sizePosition before ever
  // reaching checkConcentration at this notional, which is a real, separate
  // finding (FM-12), not something to route around here.
  const markPrice = new Big("1");
  const qtyStep = new Big("1"); // $1 notional per lot step at this price

  it("accepts a position that sizes to EXACTLY the 25% boundary", () => {
    const sized = sizePosition({ targetNotional: new Big("2500"), markPrice, perpQtyStep: qtyStep });
    if (!sized.allowed) throw new Error("expected sizePosition to allow this input");
    const realNotional = sized.spotQty.times(markPrice);
    expect(realNotional.toString()).toBe("2500");

    const result = checkConcentration(realNotional, totalEquity);
    expect(result.allowed).toBe(true);
  });

  it("denies a position sized one real lot step ($1) above the boundary — not an arbitrary epsilon", () => {
    const sized = sizePosition({ targetNotional: new Big("2501"), markPrice, perpQtyStep: qtyStep });
    if (!sized.allowed) throw new Error("expected sizePosition to allow this input");
    const realNotional = sized.spotQty.times(markPrice);
    expect(realNotional.toString()).toBe("2501"); // exactly one lot step past the boundary

    const result = checkConcentration(realNotional, totalEquity);
    expect(result).toMatchObject({ allowed: false, code: "CONCENTRATION_EXCEEDED" });
  });
});
