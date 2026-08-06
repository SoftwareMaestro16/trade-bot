import Big from "big.js";

export interface RealizedPnlInput {
  /**
   * Notional of EACH leg (perp ≈ spot, equal to each other by construction —
   * RSK-07/08: spot is sized from perp's rounded quantity) AT ENTRY, i.e.
   * `q × price_at_entry` for whichever price entryBasis is itself normalized
   * by. NOT the same number as exitLegNotional whenever the underlying price
   * moved between entry and exit — see computeRealizedPnl's own doc comment
   * for why collapsing these into one shared value is a real, silent bug.
   */
  entryLegNotional: Big;
  /**
   * Notional of EACH leg AT EXIT: `q` is the SAME fixed quantity as at entry
   * (this strategy does not rebalance mid-hold), but the price it's valued
   * at has moved, so this is generally a DIFFERENT number from
   * entryLegNotional. Must use the same price convention exitBasis itself
   * is normalized by, for the same reason entryLegNotional must match
   * entryBasis's convention — an inconsistent pairing silently reintroduces
   * the same error this two-notional split exists to fix.
   */
  exitLegNotional: Big;
  /** (perp − spot) / spot at entry, signed fraction, measured from markPrice (RISK-REGISTER.md FM-06). */
  entryBasis: Big;
  /** Same measurement at exit. */
  exitBasis: Big;
  /** Sum of all funding payments received over the hold, signed (positive = net received). */
  grossFundingCollected: Big;
  /** Sum of all four legs' fees — always a cost, pass as a positive value. */
  totalFees: Big;
  /** Sum of realized slippage cost across all four legs — always a cost, pass as a positive value. */
  realizedSlippage: Big;
}

/**
 * FR-201 (SRS.md): "Расчёт P&L с полными комиссиями по четырём ногам и оценкой
 * проскальзывания." Shared by Phase 2 (virtual fills, same formula, FR-200)
 * and later phases (real fills) — a position's realized P&L does not care
 * whether the fills were simulated or real, only what they were.
 *
 * Basis P&L derivation, fixed quantity q (short perp + long spot, no
 * rebalancing mid-hold), ignoring funding:
 *   total = q×(perp_entry − perp_exit) + q×(spot_exit − spot_entry)     [short perp profit + long spot profit]
 *         = q×(perp_entry − spot_entry) − q×(perp_exit − spot_exit)
 *         = entryLegNotional×entryBasis − exitLegNotional×exitBasis     [basis_x × notional_x = (perp_x − spot_x)×q]
 *
 * This is DELIBERATELY two separate notionals, not one `legNotional` shared
 * across both terms: a single shared value is only exact when the
 * underlying price happened not to move between entry and exit — i.e.
 * exactly the one case RISK-REGISTER.md FM-06's own worked example tests
 * (exitBasis=0, so the exit term vanishes regardless of which notional
 * multiplies it, silently hiding the bug). For any real trade where price
 * moves, that collapsed version silently mis-states P&L by
 * `(entryLegNotional − exitLegNotional) × exitBasis` — a real dollar error,
 * not a rounding artifact, and one no test caught before this fix because
 * every existing case happened to use equal entry/exit notionals.
 */
export function computeRealizedPnl(input: RealizedPnlInput): Big {
  const basisPnl = input.entryBasis
    .times(input.entryLegNotional)
    .minus(input.exitBasis.times(input.exitLegNotional));
  return input.grossFundingCollected
    .plus(basisPnl)
    .minus(input.totalFees)
    .minus(input.realizedSlippage);
}

export interface RealizedPnlBreakdown {
  fundingComponent: Big;
  basisComponent: Big;
  feesComponent: Big; // negative (a cost)
  slippageComponent: Big; // negative (a cost)
  total: Big;
}

/**
 * Same computation as computeRealizedPnl, but returns every term separately.
 * FR-202 (SRS.md): "каждое решение логируется с обоснованием, не фактом" —
 * a daily summary or a paper-trading log line that only shows the final
 * number is exactly the kind of unexplainable output that requirement
 * forbids; this is what a log line or the Telegram digest should actually render.
 */
export function computeRealizedPnlBreakdown(input: RealizedPnlInput): RealizedPnlBreakdown {
  const basisComponent = input.entryBasis
    .times(input.entryLegNotional)
    .minus(input.exitBasis.times(input.exitLegNotional));
  const feesComponent = input.totalFees.times(-1);
  const slippageComponent = input.realizedSlippage.times(-1);
  const total = input.grossFundingCollected.plus(basisComponent).plus(feesComponent).plus(slippageComponent);

  return {
    fundingComponent: input.grossFundingCollected,
    basisComponent,
    feesComponent,
    slippageComponent,
    total,
  };
}
