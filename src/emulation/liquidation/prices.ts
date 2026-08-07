import Big from "big.js";
import type { MarginTier } from "./marginTiers.js";

/**
 * Maintenance margin, bankruptcy price, and liquidation price formulas — split
 * out of `../liquidation.ts` (see that file's own top-level doc comment for
 * full citation sources 1-8, which this section's comments below reference by
 * number).
 */

// ---------------------------------------------------------------------------
// Maintenance margin
// ---------------------------------------------------------------------------

/**
 * Source 3 (Glossary): "Maintenance Margin = Position Size × Mark Price ×
 * Maintenance Margin Rate + Estimated Fee to Close Position." Source 1's own
 * worked example makes the (there implicit) `mmDeduction` term explicit:
 * "Maintenance Margin = (40,000 x 0.5%) − 0 + 21.56 = 221.56 USDT" — i.e. the
 * full formula this function implements is
 *   MM = positionNotional × tier.maintenanceMarginRate − tier.mmDeduction + feeToClose
 * `feeToClose` defaults to zero: Bybit's own liquidation-PRICE formula (see
 * `computeLiquidationPriceLong`/`Short` below) approximates this term away
 * entirely ("Minor differences from the actual liquidation price may arise
 * due to the fees to close the position(s)" — source 1), so most callers of
 * THIS function want the fee-free figure too, for consistency with whichever
 * liquidation price they are comparing it against.
 */
export function computeMaintenanceMargin(positionNotional: Big, tier: MarginTier, feeToClose: Big = new Big(0)): Big {
  return positionNotional.times(tier.maintenanceMarginRate).minus(tier.mmDeduction).plus(feeToClose);
}

// ---------------------------------------------------------------------------
// Bankruptcy price
// ---------------------------------------------------------------------------

function validatePositiveLeverage(leverage: Big): void {
  if (leverage.lte(0)) {
    throw new RangeError(`leverage must be positive, got ${leverage.toString()}`);
  }
}

/**
 * Source 2, "Bankruptcy Price under Isolated Margin Mode", USDT contracts:
 * "For Buy/Long: Bankruptcy Price = Entry Price × (1 − Initial Margin Rate)"
 * where "Initial Margin Rate (IMR) = 1 ÷ Leverage." Worked example quoted
 * verbatim: "Trader A holds a BTCUSDT Long position with an entry price at
 * 60,000 USDT, leverage is 50x. Bankruptcy Price = 60,000 × [1 − (1 ÷ 50)] =
 * 58,800 USDT" — used as this function's own golden test.
 */
export function computeBankruptcyPriceLong(entryPrice: Big, leverage: Big): Big {
  validatePositiveLeverage(leverage);
  const imr = new Big(1).div(leverage);
  return entryPrice.times(new Big(1).minus(imr));
}

/**
 * Source 2, same section: "For Sell/Short: Bankruptcy Price = Entry Price ×
 * (1 + Initial Margin Rate)." This is the side our delta-neutral strategy
 * actually uses (short perp leg) — see `computeDeltaNeutralPerpLegLiquidation`.
 * Source 2 does not publish a numeric USDT-isolated SHORT example (its only
 * worked short example is for Inverse contracts, a different, non-linear
 * formula quoted separately in source 2 and not implemented here — this
 * strategy never trades Inverse contracts, see PROJECT.md §1's "Bybit, API
 * V5" scoping to the USDT-margined universe). This function's correctness for
 * the short side is therefore validated by algebraic mirroring against the
 * long side's own officially-verified example, in this module's test file —
 * NOT against a second independent official number. Flagged in
 * open_questions.
 */
export function computeBankruptcyPriceShort(entryPrice: Big, leverage: Big): Big {
  validatePositiveLeverage(leverage);
  const imr = new Big(1).div(leverage);
  return entryPrice.times(new Big(1).plus(imr));
}

// ---------------------------------------------------------------------------
// Liquidation price (Isolated Margin, USDT Perpetual & Expiry)
// ---------------------------------------------------------------------------

export interface IsolatedLiquidationInput {
  entryPrice: Big;
  /** Position size in base-asset units (Bybit's "Position Size" / "Contract Size"), > 0. */
  qty: Big;
  /** Leverage the isolated position's initial margin was posted at, > 0. */
  leverage: Big;
  /** The risk-limit tier applicable to this position's notional — see `lookupMarginTier`. Not looked up internally: same "caller supplies it" convention as risk/leverage.ts's `checkAccountMMRate`. */
  tier: MarginTier;
  /**
   * Perp taker fee rate, used only to normalize `extraMarginAdded` (see the
   * formula below) — NEVER a hardcoded constant here, same RR-26 convention
   * emulation/borrowCost.ts's `hourlyBorrowRate` parameter follows: read live
   * from `/v5/account/fee-rate` at startup, this function just consumes it.
   */
  takerFeeRate: Big;
  /** Manual isolated-margin top-up added after entry ("Extra Margin Added" in source 1). Defaults to 0 — the common case for this strategy, which does not manually manage margin mid-hold. */
  extraMarginAdded?: Big;
}

function validateIsolatedLiquidationInput(input: IsolatedLiquidationInput): void {
  if (input.qty.lte(0)) {
    throw new RangeError(`qty must be positive, got ${input.qty.toString()}`);
  }
  validatePositiveLeverage(input.leverage);
}

/**
 * Source 1, "USDT Perpetual and Expiry Contracts" -> "Formulas" -> "For
 * Buy/Long," quoted verbatim:
 *   "Liquidation Price (Long) = [(Entry Price × Position Size) − (Entry Price
 *   × Position Size ÷ Leverage) − (Extra Margin Added ÷ (1 − Taker Fee Rate))
 *   − MM Deduction] ÷ [Position Size − (Position Size × MM Rate)]"
 *
 * Validated against source 1's own fully worked example (BTC long, 1 BTC @
 * 40,000 USDT entry, 50x leverage, 3,000 USDT extra margin added, MMR 0.5%,
 * taker fee 0.0550%, MM Deduction 0): the source states the resulting
 * Liquidation Price is 36,380.25 USDT. This module's test file reproduces
 * those exact inputs and asserts the result within $0.01 of that published,
 * rounded figure (independently hand-verified during development to
 * ≈36,380.2503... before rounding, confirming the source's own rounding
 * rather than a coincidence).
 */
export function computeLiquidationPriceLong(input: IsolatedLiquidationInput): Big {
  validateIsolatedLiquidationInput(input);
  const extraMargin = input.extraMarginAdded ?? new Big(0);
  const positionValue = input.entryPrice.times(input.qty);

  const numerator = positionValue
    .minus(positionValue.div(input.leverage))
    .minus(extraMargin.div(new Big(1).minus(input.takerFeeRate)))
    .minus(input.tier.mmDeduction);
  const denominator = input.qty.minus(input.qty.times(input.tier.maintenanceMarginRate));

  return numerator.div(denominator);
}

/**
 * Source 1, same section, "For Sell/Short," quoted verbatim:
 *   "Liquidation Price (Short) = [(Entry Price × Position Size) + (Entry
 *   Price × Position Size ÷ Leverage) + (Extra Margin Added ÷ (1 + Taker Fee
 *   Rate)) + MM Deduction] ÷ [Position Size + (Position Size × MM Rate)]"
 *
 * This is the formula our strategy actually needs — the delta-neutral pair's
 * perp leg is always short (PARAMS-CONSERVATIVE.md §6). See
 * `computeLiquidationPriceLong`'s own doc comment for how the LONG side of
 * this same formula pair was validated against source 1's official worked
 * example; this SHORT side is the exact mirror (every `−` flipped to `+`,
 * quoted directly from the same source, not derived) but is not itself
 * covered by an official worked NUMBER the way the long side is — flagged in
 * open_questions, same caveat as `computeBankruptcyPriceShort`.
 */
export function computeLiquidationPriceShort(input: IsolatedLiquidationInput): Big {
  validateIsolatedLiquidationInput(input);
  const extraMargin = input.extraMarginAdded ?? new Big(0);
  const positionValue = input.entryPrice.times(input.qty);

  const numerator = positionValue
    .plus(positionValue.div(input.leverage))
    .plus(extraMargin.div(new Big(1).plus(input.takerFeeRate)))
    .plus(input.tier.mmDeduction);
  const denominator = input.qty.plus(input.qty.times(input.tier.maintenanceMarginRate));

  return numerator.div(denominator);
}

// ---------------------------------------------------------------------------
// Delta-neutral pair: perp-leg-specific liquidation
// ---------------------------------------------------------------------------

export interface DeltaNeutralLiquidationInput {
  /** Short perp leg's entry (fill) price — same field as equityEngine.ts's `EquitySnapshotInput.perpEntryPrice`. */
  perpEntryPrice: Big;
  /** Fixed qty of the perp leg (== spot leg's qty by construction, RSK-07/08 — see equityEngine.ts's own doc comment). Only the perp leg's qty is relevant here: the spot leg has no margin/liquidation mechanics of its own (see this module's top-level doc comment). */
  qty: Big;
  /** Leverage the perp leg's isolated margin was posted at — same field as equityEngine.ts's `EquitySnapshotInput.leverage`. */
  leverage: Big;
  /** Risk-limit tier for the perp leg's notional — see `lookupMarginTier`. */
  tier: MarginTier;
  /** Perp taker fee rate — see `IsolatedLiquidationInput.takerFeeRate`. */
  takerFeeRate: Big;
  /** Manual isolated-margin top-up on the perp leg since entry, if any. Defaults to 0. */
  extraMarginAdded?: Big;
}

export interface DeltaNeutralLiquidationResult {
  /**
   * Mark price at which Bybit's isolated-margin liquidation engine takes over
   * the SHORT PERP LEG (crossing this price does not by itself close the
   * position at this exact number — see `perpBankruptcyPrice`; this is the
   * trigger, not the fill).
   */
  perpLiquidationPrice: Big;
  /** Price at which the perp leg's isolated margin balance hits exactly zero — the takeover/fill price once liquidation is triggered (source 2). */
  perpBankruptcyPrice: Big;
  /**
   * Always `false`. Documents, rather than computes, this module's central
   * finding for the delta-neutral case (see this module's top-level doc
   * comment "SCOPE" section): the spot leg is bought outright with cash
   * (RR-25a) and has no margin, no MMR, and therefore no liquidation price of
   * its own on Bybit. This field exists so a caller reading this result's
   * shape cannot mistake the absence of a `spotLiquidationPrice` field for an
   * oversight, and so a test can assert the invariant directly rather than
   * only in a comment.
   */
  spotLegCanBeLiquidated: false;
}

/**
 * Computes the short perp leg's own isolated liquidation/bankruptcy price —
 * the only liquidation-relevant number a delta-neutral pair actually has, per
 * this module's top-level "SCOPE" doc comment. Thin wrapper over
 * `computeLiquidationPriceShort` / `computeBankruptcyPriceShort`, fixing
 * side=short (this strategy never holds a long perp / short spot pair — see
 * PARAMS-CONSERVATIVE.md §6) and documenting the resulting shape so the
 * "what about the spot leg" question has an explicit, tested answer instead
 * of a silent gap.
 */
export function computeDeltaNeutralPerpLegLiquidation(
  input: DeltaNeutralLiquidationInput,
): DeltaNeutralLiquidationResult {
  const perpLiquidationPrice = computeLiquidationPriceShort({
    entryPrice: input.perpEntryPrice,
    qty: input.qty,
    leverage: input.leverage,
    tier: input.tier,
    takerFeeRate: input.takerFeeRate,
    // exactOptionalPropertyTypes: `extraMarginAdded?: Big` means the key must
    // be ABSENT when there's no value, not present-and-undefined — spreading
    // conditionally instead of `extraMarginAdded: input.extraMarginAdded`
    // (which would be `Big | undefined`, not assignable to `Big`).
    ...(input.extraMarginAdded !== undefined ? { extraMarginAdded: input.extraMarginAdded } : {}),
  });
  const perpBankruptcyPrice = computeBankruptcyPriceShort(input.perpEntryPrice, input.leverage);

  return { perpLiquidationPrice, perpBankruptcyPrice, spotLegCanBeLiquidated: false };
}
