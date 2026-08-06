import Big from "big.js";

/**
 * Backlog #35 (Фаза 2): mark-to-market equity of ONE virtual delta-neutral
 * pair (spot leg + short perp leg) as a function of time. "As a function of
 * time" means this module holds no clock and no state — a caller (the
 * scenario runner / paper-trading replay loop, not yet built) calls
 * `computeEquitySnapshot` again on every tick with that tick's mark prices
 * and that tick's accumulated funding/borrow totals, and gets back that
 * tick's equity. This file itself is pure, same as risk/ and strategy/.
 *
 * Scope is ONE position, not the whole account: risk/drawdown.ts's own doc
 * says drawdown must be measured from equity that already includes BOTH legs
 * of a pair (spot alone or perp alone is meaningless, since they move in
 * opposite directions) — that is exactly what this module produces. If
 * multiple virtual pairs are ever open at once, summing each pair's
 * `totalEquity` (plus any idle cash) into one account-level figure before
 * calling risk/drawdown.ts is the caller's job, not this module's.
 *
 * Margin model: SRS.md RR-20's own formula is `effective leverage = short
 * notional / total equity`, and SRS.md C-04 notes the real account is cross-
 * margined (spot counts as discounted collateral, doesn't directly reduce
 * the short's initial margin) — so a byte-for-byte replica of Bybit's cross-
 * margin haircut mechanics isn't recoverable from the inputs this function
 * is given (no haircut ratio is one of them). Instead this models the
 * standard, self-consistent ISOLATED-margin accounting a paper-trading
 * ledger needs: the spot leg is bought outright with cash (RR-25a/
 * economics.ts's "spot funded only with own money"), the perp leg's initial
 * margin is `perpEntryNotional / leverage` (posted once, at entry), and from
 * then on the position's equity is that starting capital plus every P&L
 * component accrued since (basis, funding, borrow cost) — the same
 * mechanics as any margin account's `balance = initialMargin + P&L`. This is
 * a deliberate simplification of the real cross-margin account, not an
 * attempt to reproduce it exactly; backlog #34's liquidation.ts (margin-tier
 * tables) is the natural place a closer model would live if Phase 2 needs one.
 */
export interface EquitySnapshotInput {
  /** Spot leg entry fill price. */
  spotEntryPrice: Big;
  /** Perp leg (short) entry fill price, same instant as spotEntryPrice. */
  perpEntryPrice: Big;
  /**
   * Fixed quantity of BOTH legs. strategy/sizing.ts (RSK-07/08) guarantees
   * spotQty === perpQty at entry, and this strategy never rebalances
   * mid-hold — the same single-`q` invariant execution/realizedPnl.ts's
   * basisPnl derivation depends on. A single shared `qty` field here (not
   * separate spotQty/perpQty) is deliberate: that derivation is only valid
   * for one q applied to both legs, and a two-qty variant would silently
   * produce a basis figure realizedPnl.ts's own close-time math can't be
   * reconciled against.
   */
  qty: Big;
  /** Current spot mark price — this tick's snapshot instant. */
  spotMarkPrice: Big;
  /** Current perp mark price — same instant as spotMarkPrice. */
  perpMarkPrice: Big;
  /**
   * Leverage the perp leg's initial margin was posted at when the position
   * was opened — a fixed config value for the life of the position, never
   * legitimately zero or negative (unlike `totalEquity` in the returned
   * snapshot, there is no real market event that drives leverage itself to
   * zero, so this throws on an invalid value instead of being allowed
   * through like a real equity outcome). risk/leverage.ts's 1.5x hard
   * ceiling (RR-20) is enforced there, at entry decision time — this module
   * does not re-enforce it.
   */
  leverage: Big;
  /**
   * Sum of every funding payment received since entry, signed the same way
   * as execution/realizedPnl.ts's `grossFundingCollected` (positive = net
   * received). Accumulating this over time is the caller's job — this
   * function is a single-instant snapshot, not a time-series integrator.
   */
  fundingAccrued: Big;
  /**
   * Sum of borrow interest paid since entry so far, always given as a
   * POSITIVE cost — same convention as realizedPnl.ts's `totalFees` /
   * `realizedSlippage` inputs. Computing this figure (RISK-REGISTER.md
   * FM-09/FM-27) belongs to backlog #36's borrowCost.ts, not here.
   */
  borrowCostAccrued: Big;
}

/**
 * Same field-naming convention as execution/realizedPnl.ts's
 * `RealizedPnlBreakdown` (`fundingComponent`/`basisComponent`/`...Component`/
 * `total`) so an open position's mark-to-market snapshot and a closed
 * position's realized breakdown can share one log/render path (FR-202's
 * "each decision logged with justification, not just the fact"). Deliberately
 * does NOT carry `feesComponent`/`slippageComponent`: those are one-off costs
 * paid at a fill, and mid-hold there is no exit fill yet — a zero placeholder
 * for them here would imply this snapshot knows something about the eventual
 * close that it cannot.
 */
export interface EquityBreakdown {
  /** `input.fundingAccrued`, passed through unchanged. */
  fundingComponent: Big;
  /**
   * Unrealized basis P&L: `entryBasis×entryLegNotional − currentBasis×currentLegNotional`
   * — the exact formula and sign convention realizedPnl.ts's `basisComponent`
   * uses (RISK-REGISTER.md FM-06), evaluated against the current mark prices
   * instead of an exit fill. See realizedPnl.ts's own doc comment for why the
   * two notionals must stay independent (entry-time vs current-time) rather
   * than collapsed into one shared value.
   */
  basisComponent: Big;
  /** `input.borrowCostAccrued` negated to a cost — always <= 0, same sign convention as `RealizedPnlBreakdown`'s cost components. */
  borrowCostComponent: Big;
  /** `fundingComponent + basisComponent + borrowCostComponent`. */
  total: Big;
}

export interface EquitySnapshot {
  breakdown: EquityBreakdown;
  /**
   * Capital committed to open this virtual position: the full spot notional
   * (paid outright in cash) plus the perp leg's initial margin
   * (`perpEntryNotional / leverage`). This is the position's starting equity
   * BEFORE any P&L — see this module's own doc comment for why it is not a
   * literal reproduction of Bybit's cross-margin haircut mechanics.
   */
  initialCapital: Big;
  /**
   * `initialCapital + breakdown.total` — feed this Big DIRECTLY into
   * risk/drawdown.ts's `computeDrawdown`/`checkDrawdown` as `currentEquity`,
   * no adapter needed (that is exactly the shape those functions take).
   *
   * Can be ZERO or NEGATIVE after a hypothetical liquidation-magnitude move
   * against the short perp leg. This is deliberate: risk/leverage.ts's
   * `checkLeverage` throws a `RangeError` on `totalEquity <= 0` on the
   * (audited-as-wrong) assumption that state "cannot happen under correct
   * business logic" — but at liquidation, equity legitimately reaching
   * zero/negative is exactly the state this engine exists to represent, not
   * a caller bug. This function must never throw on that outcome the way
   * checkLeverage does; it only throws on invalid CONFIGURATION input
   * (`leverage <= 0`), never on a bad market outcome.
   */
  totalEquity: Big;
}

/**
 * Pure mark-to-market snapshot for one delta-neutral pair at one instant.
 * See this module's own doc comment for the margin model and scope.
 */
export function computeEquitySnapshot(input: EquitySnapshotInput): EquitySnapshot {
  if (input.leverage.lte(0)) {
    // Leverage is a fixed exchange config value for the life of this
    // position, never legitimately <= 0 — unlike totalEquity below, there is
    // no real market state that produces it, so failing loudly here does not
    // repeat risk/leverage.ts's audited totalEquity<=0 bug (see totalEquity's
    // doc comment on EquitySnapshot above): that bug was throwing on a real,
    // reachable MARKET outcome; this is throwing on an impossible CONFIG value.
    throw new RangeError(`leverage must be positive, got ${input.leverage.toString()}`);
  }

  // Same normalization convention as realizedPnl.ts: basis is (perp − spot) / spot,
  // and legNotional uses whichever price the basis is normalized by — spot, here.
  const entryLegNotional = input.qty.times(input.spotEntryPrice);
  const currentLegNotional = input.qty.times(input.spotMarkPrice);
  const entryBasis = input.perpEntryPrice.minus(input.spotEntryPrice).div(input.spotEntryPrice);
  const currentBasis = input.perpMarkPrice.minus(input.spotMarkPrice).div(input.spotMarkPrice);

  const basisComponent = entryBasis
    .times(entryLegNotional)
    .minus(currentBasis.times(currentLegNotional));
  const fundingComponent = input.fundingAccrued;
  const borrowCostComponent = input.borrowCostAccrued.times(-1);
  const total = fundingComponent.plus(basisComponent).plus(borrowCostComponent);

  const perpEntryNotional = input.qty.times(input.perpEntryPrice);
  const perpInitialMargin = perpEntryNotional.div(input.leverage);
  const initialCapital = entryLegNotional.plus(perpInitialMargin);

  const totalEquity = initialCapital.plus(total);

  return {
    breakdown: { fundingComponent, basisComponent, borrowCostComponent, total },
    initialCapital,
    totalEquity,
  };
}
