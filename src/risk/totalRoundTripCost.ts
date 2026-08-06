import Big from "big.js";

export interface TotalRoundTripCostInput {
  /**
   * Taker fee for the ENTRY spot leg (buy), fraction of notional — e.g.
   * `0.001` = 0.10% VIP0 (PARAMS-CONSERVATIVE.md §6: "обе ноги taker", spot
   * maker=taker on VIP0 so post-only saves nothing). RR-26/FM-02: this is a
   * mandatory argument with no hardcoded default inside this module — the
   * real number comes from `GET /v5/account/fee-rate` at startup, VIP0
   * hardcoded only as the caller's fallback (checkFeeRateSanity in
   * risk/economics.ts sanity-checks whatever value is actually supplied).
   */
  entrySpotFeeRate: Big;
  /** Taker fee for the ENTRY perp leg (short), fraction of notional. */
  entryPerpFeeRate: Big;
  /**
   * Taker fee for the EXIT spot leg (sell), fraction of notional. Kept as a
   * field separate from `entrySpotFeeRate` — not reused/doubled — for the
   * same reason execution/realizedPnl.ts keeps `entryLegNotional` and
   * `exitLegNotional` separate rather than one shared value: fee schedules
   * are read fresh per RR-26 ("ежедневно" per FM-02), so a VIP-tier change or
   * promo mid-hold is a real, if rare, case a collapsed single rate would
   * silently mis-price. In the common case the caller passes the same value
   * as `entrySpotFeeRate`; this function does not assume that for them.
   */
  exitSpotFeeRate: Big;
  /** Taker fee for the EXIT perp leg (buy to close), fraction of notional. */
  exitPerpFeeRate: Big;

  /**
   * Estimated cost, as a fraction of notional, of the entry/exit basis
   * having moved against the position by the time it's unwound — always a
   * cost, pass as a positive value. This is a forward-looking ESTIMATE the
   * caller supplies (e.g. a recent observed basis-volatility figure); this
   * function does not derive or measure it. Not the same number as
   * strategy/exitRules.ts's `basisDivergence` (PARAMS-CONSERVATIVE.md §7.3's
   * 0.5% emergency-exit trigger) — that's a REALIZED divergence measured
   * live during a hold and compared against a hard exit threshold; this is a
   * pre-trade cost estimate netted against expected gross income. The two
   * happen to be about the same underlying risk but are not interchangeable
   * values.
   */
  expectedBasisDivergence: Big;

  /**
   * Entry spot leg's slippage estimate, fraction of notional — the
   * `slippageBp` field of risk/liquidity.ts's `estimateSlippage(spotAsks,
   * targetNotional)` result. Reuse that same call's output rather than
   * re-walking the book here: risk/index.ts's `checkSlippage` veto and this
   * cost figure must agree on what the book actually costs, and calling
   * `estimateSlippage` twice against a book that could itself change between
   * calls would risk exactly that kind of silent disagreement.
   */
  entrySpotSlippageBp: Big;
  /** Entry perp leg's slippage estimate — `estimateSlippage(perpBids, targetNotional).slippageBp`. */
  entryPerpSlippageBp: Big;
  /**
   * Exit spot leg's slippage estimate, fraction of notional. UNLIKE the
   * entry fields, this cannot come from `estimateSlippage` against a live
   * book — the book at exit time doesn't exist yet at entry-decision time.
   * The caller must supply a documented estimate (RISK-REGISTER.md FM-03
   * notes exit-side books are systematically worse than entry-side, so
   * reusing the entry figure unmodified is a lower-bound assumption, not a
   * neutral one) — this function takes whatever number it's given and does
   * not itself decide how exit slippage should be projected.
   */
  exitSpotSlippageBp: Big;
  /** Exit perp leg's slippage estimate — same caller-supplied-estimate caveat as `exitSpotSlippageBp`. */
  exitPerpSlippageBp: Big;
}

/**
 * FR-201 (SRS.md) / RISK-REGISTER.md FM-01, FM-02, FM-03: assembles the
 * "круг комиссий" (round-trip cost) figure that risk/economics.ts's
 * `checkEntryThreshold` compares expected gross funding income against
 * (`expectedGross >= K * totalRoundTripCost`). Every term here — like
 * `r8h` itself — is a signed-as-positive-cost FRACTION OF NOTIONAL, not an
 * absolute currency amount and not a percentage string; `checkEntryThreshold`
 * multiplies this directly against `r8h.times(expectedHoldIntervals)`, so a
 * unit mismatch here would silently corrupt every entry decision.
 *
 * PARAMS-CONSERVATIVE.md §6's own worked baseline (VIP0, both legs taker,
 * spot maker=taker so post-only saves nothing) sums to ≈0.31% round-trip
 * before basis/slippage are added — this function does not hardcode that
 * 0.31% figure anywhere, since RR-26 requires the real fee rates to come
 * from the exchange at startup, not a baked-in constant.
 */
export function computeTotalRoundTripCost(input: TotalRoundTripCostInput): Big {
  return input.entrySpotFeeRate
    .plus(input.entryPerpFeeRate)
    .plus(input.exitSpotFeeRate)
    .plus(input.exitPerpFeeRate)
    .plus(input.expectedBasisDivergence)
    .plus(input.entrySpotSlippageBp)
    .plus(input.entryPerpSlippageBp)
    .plus(input.exitSpotSlippageBp)
    .plus(input.exitPerpSlippageBp);
}

export interface TotalRoundTripCostBreakdown {
  feesComponent: Big;
  basisComponent: Big;
  slippageComponent: Big;
  total: Big;
}

/**
 * Same computation as computeTotalRoundTripCost, but grouped into the three
 * named categories FR-202 (SRS.md) requires a log line to show ("каждое
 * решение логируется с обоснованием, не фактом") — mirrors
 * execution/realizedPnl.ts's computeRealizedPnlBreakdown, which exists for
 * the identical reason on the P&L side of the same requirement.
 */
export function computeTotalRoundTripCostBreakdown(input: TotalRoundTripCostInput): TotalRoundTripCostBreakdown {
  const feesComponent = input.entrySpotFeeRate
    .plus(input.entryPerpFeeRate)
    .plus(input.exitSpotFeeRate)
    .plus(input.exitPerpFeeRate);
  const basisComponent = input.expectedBasisDivergence;
  const slippageComponent = input.entrySpotSlippageBp
    .plus(input.entryPerpSlippageBp)
    .plus(input.exitSpotSlippageBp)
    .plus(input.exitPerpSlippageBp);
  const total = feesComponent.plus(basisComponent).plus(slippageComponent);

  return { feesComponent, basisComponent, slippageComponent, total };
}
