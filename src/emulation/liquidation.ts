import Big from "big.js";

/**
 * Backlog #34: liquidation price / bankruptcy price / margin-tier lookup for
 * the perp leg of a delta-neutral pair, plus a forced-liquidation simulator
 * over a historical mark-price series. This is the "closer model" that
 * emulation/equityEngine.ts's own doc comment names as the natural home for
 * Bybit's real isolated-margin mechanics (that module deliberately uses a
 * simplified `initialMargin = notional / leverage` accounting instead).
 *
 * ALL formulas below are transcribed verbatim from Bybit's official Help
 * Center (fetched live 2026-08-06 — WebFetch timed out repeatedly against
 * bybit.com in this environment, so the pages were read via a live browser
 * session instead; every quote below was read directly off the rendered
 * page, not reconstructed from memory or training data):
 *
 * 1. "Trading Rules: Liquidation Process (Unified Trading Account)"
 *    https://www.bybit.com/en/help-center/article/UTA-Trading-Rules
 *    — Isolated Margin liquidation price formulas (USDT Perpetual & Expiry),
 *    with a fully worked numeric example used below as a golden test case.
 * 2. "Bankruptcy Price (Perpetual and Expiry Contracts)"
 *    https://www.bybit.com/en/help-center/article/Bankruptcy-Price-Perpetual-and-Expiry-Contracts
 *    — Isolated Margin bankruptcy price formulas, also with a worked example.
 * 3. "Trading Terms and Formulas in Unified Trading Account"
 *    https://www.bybit.com/en/help-center/article/Glossary-Unified-Trading-Account
 *    — general Maintenance Margin formula.
 * 4. "Risk Limit (Perpetual and Expiry Contracts)"
 *    https://www.bybit.com/en/help-center/article/Risk-Limit-USDT-Contract
 *    — how a position's notional selects a risk-limit tier (and therefore its
 *    MMR/IMR), including a BTCUSDT worked example this file's own hardcoded
 *    BTCUSDT table is cross-checked against (see KNOWN_MARGIN_TIERS below).
 * 5. "Maintenance Margin Rate (MMR) Close Order"
 *    https://www.bybit.com/en/help-center/article/Maintenance-Margin-Rate-MMR-Close-Order
 *    — confirms account-level MMR reaching 100% is what actually liquidates a
 *    Cross/Portfolio Margin UTA account, the mechanism risk/leverage.ts's
 *    `checkAccountMMRate` guards against at a much stricter 30% ceiling.
 * 6. `GET /v5/market/risk-limit?category=linear&symbol=<SYM>` — Bybit's public
 *    V5 REST endpoint. A live snapshot of this endpoint (captured 2026-08-05)
 *    is the literal source of every number in KNOWN_MARGIN_TIERS below; it was
 *    cross-checked against source 7's own worked example (see that constant's
 *    doc comment) rather than trusted blind.
 * 7. "Maintenance Margin (USDT Perpetual and Expiry Contracts)"
 *    https://www.bybit.com/en/help-center/article/Maintenance-Margin-USDT-Contract
 *    — the actual source of the BTCUSDT worked example used to cross-check
 *    KNOWN_MARGIN_TIERS (2,000,000 USDT / 0.5% MMR, 2,600,000 USDT / 0.56%
 *    MMR). An earlier version of this file misattributed this exact quote to
 *    source 4 (Risk-Limit-USDT-Contract) — caught by independent verification
 *    2026-08-06: source 4 covers tier-SELECTION mechanics, not this worked
 *    example. The numbers themselves were always correct; only the citation
 *    was wrong.
 *
 * SCOPE — why this only ever prices the PERP leg, never "the pair":
 * PARAMS-CONSERVATIVE.md §6 / RR-25a fix the spot leg as bought outright with
 * cash ("spot funded only with own money") — an unlevered spot holding has no
 * margin, no MMR, and no liquidation price on Bybit; it can only ever be sold
 * at whatever the market will pay. Isolated Margin mode (the model
 * equityEngine.ts already commits to — see that module's own doc comment) also
 * prices each position independently: source 1 above states plainly
 * "Liquidation of one position will not affect the other position." So a
 * delta-neutral pair's "liquidation price" is not a single combined number —
 * it is the short PERP leg's own isolated liquidation price, full stop. What
 * the delta-neutral framing actually adds is the consequence, not the formula:
 * once the perp leg is liquidated, the spot leg is still open and now carries
 * full, unhedged directional exposure — delta-neutrality was a property of
 * the PAIR, and it dies the instant either leg is forcibly closed. See
 * `computeDeltaNeutralPerpLegLiquidation`'s own doc comment.
 */

// ---------------------------------------------------------------------------
// Margin tiers (risk-limit lookup)
// ---------------------------------------------------------------------------

export type MarginTierSource = "bybit-api-snapshot" | "conservative-placeholder";

/**
 * One row of a symbol's risk-limit tier ladder. Field names mirror Bybit's
 * own `GET /v5/market/risk-limit` response fields 1:1 (`maintenanceMargin` ->
 * `maintenanceMarginRate`, `initialMargin` -> `initialMarginRate`,
 * `riskLimitValue`, `maxLeverage`, `mmDeduction`) so a live API response can
 * be mapped onto this shape without renaming, once that ingestion is wired up
 * (see this module's own top-level doc comment, source 6, and open_questions
 * in the PR/task description for why that ingestion is NOT built here).
 */
export interface MarginTier {
  /** 1-based rank within the symbol's ladder, ascending risk (1 = isLowestRisk in Bybit's API). */
  tier: number;
  /**
   * Upper bound (USDT) of position notional this tier covers. Source 7:
   * "when you open a BTCUSDT position with a position value of 2,000,000 USDT
   * or below, the maintenance margin rate (MMR) required for the position is
   * 0.5%" — "or below" is why tier lookup below uses an INCLUSIVE `<=` at
   * this boundary, not a strict `<`.
   */
  riskLimitValue: Big;
  /** Bybit's `maintenanceMargin` field — a fraction (0.005 = 0.5%), not a percent. */
  maintenanceMarginRate: Big;
  /** Bybit's `initialMargin` field — a fraction, not a percent. */
  initialMarginRate: Big;
  /** Bybit's `maxLeverage` field for this tier. */
  maxLeverage: Big;
  /**
   * Bybit's `mmDeduction` field: a linear correction constant subtracted in
   * the Maintenance Margin formula (see `computeMaintenanceMargin`). The risk
   * limit tier system charges a position's ENTIRE notional the selected
   * tier's flat MMR rather than a graduated/marginal per-bracket sum (unlike,
   * e.g., a tax bracket) — `mmDeduction` is Bybit's own constant that keeps
   * that flat-rate shortcut continuous across tier boundaries instead of
   * jumping discontinuously at each one. Always 0 for tier 1 (the API returns
   * `""` for tier 1's `mmDeduction`, since there is nothing below it to
   * correct for).
   */
  mmDeduction: Big;
  /**
   * `"bybit-api-snapshot"` for a tier transcribed from a real, dated API
   * response (see the tier table's own doc comment for the capture date);
   * `"conservative-placeholder"` for `FALLBACK_CONSERVATIVE_TIER`, which is
   * NOT observed Bybit data for any symbol. A caller about to risk real
   * capital on a specific symbol should check this field and refuse to trade
   * on a `"conservative-placeholder"` tier rather than silently accepting an
   * approximation — this module does not enforce that itself (it has no veto
   * power; see ARCHITECTURE.md §2, risk/ owns vetoes, not emulation/).
   */
  source: MarginTierSource;
}

export type MarginTierTable = Readonly<Record<string, readonly MarginTier[]>>;

/** Internal: converts a compact tuple row into a fully-typed, Big-valued MarginTier. */
function buildTier(
  tier: number,
  riskLimitValue: string,
  maintenanceMarginRate: string,
  initialMarginRate: string,
  maxLeverage: string,
  mmDeduction: string,
  source: MarginTierSource,
): MarginTier {
  return {
    tier,
    riskLimitValue: new Big(riskLimitValue),
    maintenanceMarginRate: new Big(maintenanceMarginRate),
    initialMarginRate: new Big(initialMarginRate),
    maxLeverage: new Big(maxLeverage),
    mmDeduction: new Big(mmDeduction),
    source,
  };
}

/**
 * [riskLimitValue, maintenanceMargin, initialMargin, maxLeverage, mmDeduction]
 * per tier, transcribed verbatim (field order matches the raw API's own field
 * order) from a live snapshot of `GET /v5/market/risk-limit?category=linear&
 * symbol=BTCUSDT`, captured 2026-08-05. Tier 1's `mmDeduction` was `""` in the
 * raw response (no correction below the lowest tier) and is written here as
 * `"0"`.
 *
 * Cross-checked against source 7's own worked example, independent of the
 * captured API snapshot: "position value of 2,000,000 USDT or below ... MMR
 * ... 0.5% ... if the position value increases to 2,600,000 USDT, the MMR
 * required will also increase to 0.56%" — matches tier 1 (riskLimitValue
 * 2,000,000 / MMR 0.005) and tier 2 (riskLimitValue 2,600,000 / MMR 0.0056)
 * below exactly.
 */
const BTCUSDT_TIERS: readonly MarginTier[] = [
  buildTier(1, "2000000", "0.005", "0.01", "100.00", "0", "bybit-api-snapshot"),
  buildTier(2, "2600000", "0.0056", "0.0111", "90.00", "1200", "bybit-api-snapshot"),
  buildTier(3, "3200000", "0.0063", "0.0125", "80.00", "3020", "bybit-api-snapshot"),
  buildTier(4, "3800000", "0.0067", "0.0133", "75.00", "4300", "bybit-api-snapshot"),
  buildTier(5, "4400000", "0.0071", "0.0143", "70.00", "5820", "bybit-api-snapshot"),
  buildTier(6, "5000000", "0.0077", "0.0154", "65.00", "8460", "bybit-api-snapshot"),
  buildTier(7, "5600000", "0.0091", "0.0182", "55.00", "15460", "bybit-api-snapshot"),
  buildTier(8, "8500000", "0.01", "0.02", "50.00", "20500", "bybit-api-snapshot"),
  buildTier(9, "10000000", "0.013", "0.0222", "45.00", "46000", "bybit-api-snapshot"),
  buildTier(10, "14000000", "0.015", "0.025", "40.00", "66000", "bybit-api-snapshot"),
  buildTier(11, "20000000", "0.016", "0.0286", "35.00", "80000", "bybit-api-snapshot"),
  buildTier(12, "28000000", "0.02", "0.0333", "30.00", "160000", "bybit-api-snapshot"),
  buildTier(13, "38000000", "0.025", "0.04", "25.00", "300000", "bybit-api-snapshot"),
  buildTier(14, "50000000", "0.029", "0.05", "20.00", "452000", "bybit-api-snapshot"),
  buildTier(15, "55000000", "0.03", "0.0526", "19.00", "502000", "bybit-api-snapshot"),
  buildTier(16, "60000000", "0.035", "0.0556", "18.00", "777000", "bybit-api-snapshot"),
  buildTier(17, "65000000", "0.036", "0.0588", "17.00", "837000", "bybit-api-snapshot"),
  buildTier(18, "70000000", "0.038", "0.0625", "16.00", "967000", "bybit-api-snapshot"),
  buildTier(19, "75000000", "0.04", "0.0667", "15.00", "1107000", "bybit-api-snapshot"),
  buildTier(20, "80000000", "0.045", "0.0714", "14.00", "1482000", "bybit-api-snapshot"),
  buildTier(21, "85000000", "0.05", "0.0769", "13.00", "1882000", "bybit-api-snapshot"),
  buildTier(22, "90000000", "0.055", "0.0833", "12.00", "2307000", "bybit-api-snapshot"),
  buildTier(23, "95000000", "0.06", "0.0909", "11.00", "2757000", "bybit-api-snapshot"),
  buildTier(24, "100000000", "0.065", "0.1", "10.00", "3232000", "bybit-api-snapshot"),
  buildTier(25, "105000000", "0.07", "0.1111", "9.00", "3732000", "bybit-api-snapshot"),
  buildTier(26, "110000000", "0.085", "0.125", "8.00", "5307000", "bybit-api-snapshot"),
  buildTier(27, "115000000", "0.095", "0.1429", "7.00", "6407000", "bybit-api-snapshot"),
  buildTier(28, "120000000", "0.1", "0.1667", "6.00", "6982000", "bybit-api-snapshot"),
  buildTier(29, "150000000", "0.12", "0.2", "5.00", "9382000", "bybit-api-snapshot"),
  buildTier(30, "200000000", "0.14", "0.25", "4.00", "12382000", "bybit-api-snapshot"),
  buildTier(31, "250000000", "0.18", "0.3333", "3.00", "20382000", "bybit-api-snapshot"),
  buildTier(32, "400000000", "0.3", "0.5", "2.00", "50382000", "bybit-api-snapshot"),
  buildTier(33, "600000000", "0.42", "0.6993", "1.43", "98382000", "bybit-api-snapshot"),
  buildTier(34, "800000000", "0.5", "0.7813", "1.28", "146382000", "bybit-api-snapshot"),
  buildTier(35, "1200000000", "0.6", "1", "1.00", "226382000", "bybit-api-snapshot"),
];

/**
 * Same provenance and transcription convention as BTCUSDT_TIERS above, for
 * `symbol=ADAUSDT`, captured from the same 2026-08-05 snapshot. Included
 * alongside BTCUSDT specifically because it is a much smaller-notional ladder
 * (30 tiers spanning 200K-35M USDT vs BTC's 2M-1.2B) — a useful second real
 * data point for testing tier-lookup boundaries without extrapolating from
 * BTC alone.
 */
const ADAUSDT_TIERS: readonly MarginTier[] = [
  buildTier(1, "200000", "0.0075", "0.0133", "75.00", "0", "bybit-api-snapshot"),
  buildTier(2, "300000", "0.01", "0.02", "50.00", "500", "bybit-api-snapshot"),
  buildTier(3, "500000", "0.015", "0.03", "33.33", "2000", "bybit-api-snapshot"),
  buildTier(4, "900000", "0.02", "0.04", "25.00", "4500", "bybit-api-snapshot"),
  buildTier(5, "1300000", "0.025", "0.05", "20.00", "9000", "bybit-api-snapshot"),
  buildTier(6, "1700000", "0.03", "0.06", "16.67", "15500", "bybit-api-snapshot"),
  buildTier(7, "2100000", "0.035", "0.07", "14.29", "24000", "bybit-api-snapshot"),
  buildTier(8, "2500000", "0.04", "0.08", "12.50", "34500", "bybit-api-snapshot"),
  buildTier(9, "2900000", "0.045", "0.09", "11.11", "47000", "bybit-api-snapshot"),
  buildTier(10, "3300000", "0.05", "0.1", "10.00", "61500", "bybit-api-snapshot"),
  buildTier(11, "3700000", "0.055", "0.11", "9.09", "78000", "bybit-api-snapshot"),
  buildTier(12, "4100000", "0.06", "0.12", "8.33", "96500", "bybit-api-snapshot"),
  buildTier(13, "4500000", "0.065", "0.13", "7.69", "117000", "bybit-api-snapshot"),
  buildTier(14, "4900000", "0.07", "0.14", "7.14", "139500", "bybit-api-snapshot"),
  buildTier(15, "5000000", "0.075", "0.15", "6.67", "164000", "bybit-api-snapshot"),
  buildTier(16, "7000000", "0.08", "0.16", "6.25", "189000", "bybit-api-snapshot"),
  buildTier(17, "9000000", "0.085", "0.17", "5.88", "224000", "bybit-api-snapshot"),
  buildTier(18, "11000000", "0.09", "0.18", "5.56", "269000", "bybit-api-snapshot"),
  buildTier(19, "13000000", "0.095", "0.19", "5.26", "324000", "bybit-api-snapshot"),
  buildTier(20, "15000000", "0.1", "0.2", "5.00", "389000", "bybit-api-snapshot"),
  buildTier(21, "17000000", "0.105", "0.21", "4.76", "464000", "bybit-api-snapshot"),
  buildTier(22, "19000000", "0.11", "0.22", "4.55", "549000", "bybit-api-snapshot"),
  buildTier(23, "21000000", "0.115", "0.23", "4.35", "644000", "bybit-api-snapshot"),
  buildTier(24, "23000000", "0.12", "0.24", "4.17", "749000", "bybit-api-snapshot"),
  buildTier(25, "25000000", "0.125", "0.25", "4.00", "864000", "bybit-api-snapshot"),
  buildTier(26, "27000000", "0.13", "0.26", "3.85", "989000", "bybit-api-snapshot"),
  buildTier(27, "29000000", "0.135", "0.27", "3.70", "1124000", "bybit-api-snapshot"),
  buildTier(28, "31000000", "0.2", "0.4", "2.50", "3009000", "bybit-api-snapshot"),
  buildTier(29, "33000000", "0.4", "0.7", "1.43", "9209000", "bybit-api-snapshot"),
  buildTier(30, "35000000", "0.6", "1", "1.00", "15809000", "bybit-api-snapshot"),
];

/**
 * Symbols verified against a real, dated Bybit API snapshot. This is a small
 * subset of the ~293 USDT Perpetual symbols Bybit lists (backlog note: a full
 * pull of `GET /v5/market/risk-limit` for every symbol in market-data/universe.ts's
 * universe is real, separate follow-up work — see this task's open_questions).
 */
export const KNOWN_MARGIN_TIERS: MarginTierTable = {
  BTCUSDT: BTCUSDT_TIERS,
  ADAUSDT: ADAUSDT_TIERS,
};

/**
 * Used by `lookupMarginTier` for any symbol not in KNOWN_MARGIN_TIERS. This is
 * NOT observed Bybit data for any real symbol — see MarginTier.source's own
 * doc comment for why that matters and what a caller should do about it.
 *
 * Deliberately worse (higher MMR/IMR, therefore a liquidation price closer to
 * entry — less runway) than BOTH real tier-1 samples this file has verified:
 * BTCUSDT's 0.5%/1% and ADAUSDT's 0.75%/1.33%. PARAMS-CONSERVATIVE.md §4's
 * liquidity floor (min 100M USDT perp turnover / 20M spot turnover) and its
 * Innovation/Adventure Zone exclusion mean any symbol this bot actually
 * considers is a liquid, established market — closer in kind to BTCUSDT/
 * ADAUSDT than to a thin small-cap (a real small-cap tier-1 MMR observed in
 * the same snapshot run, ESPORTSUSDT, was 5% — five times higher again than
 * this placeholder). This value is chosen to sit clearly above every real
 * liquid symbol sampled, so an unverified symbol's ESTIMATED liquidation
 * price is never reported as safer (further from entry) than a verified
 * symbol's real one would be — "лучше закрыться зря" (PROJECT.md §6) applies
 * to an estimate too. `mmDeduction: 0` is likewise the conservative choice:
 * omitting a real tier's positive deduction only ever INCREASES the computed
 * Maintenance Margin for a given notional (see `computeMaintenanceMargin`),
 * never decreases it.
 */
export const FALLBACK_CONSERVATIVE_TIER: MarginTier = buildTier(
  0,
  "0", // riskLimitValue is unused for a single-tier fallback — lookupMarginTier never consults it.
  "0.02", // MMR = 2%: ~2.7x ADAUSDT's real tier-1 MMR (0.75%), ~4x BTCUSDT's (0.5%).
  "0.04", // IMR = 4%: matches the 2:1 IMR:MMR ratio both real tables show at their own tier 1.
  "25.00",
  "0",
  "conservative-placeholder",
);

/**
 * Selects the risk-limit tier that applies to a given position notional, the
 * same way Bybit itself does — source 4: "the system will automatically
 * adjust the user's risk limit based on ... the position value ...
 * Consequently, the requirements for maintenance margin and initial margin
 * will also change accordingly," with USDT-contract position value defined
 * as `Contract Size × Mark Price` (same source, Notes section) — i.e. the
 * caller passes `qty.times(markPrice)` (or `.times(entryPrice)` for a
 * pre-trade estimate), not qty alone.
 *
 * Falls back to `FALLBACK_CONSERVATIVE_TIER` for any symbol not present in
 * `table` (default `KNOWN_MARGIN_TIERS`) — never throws for an unknown
 * symbol, matching this task's explicit instruction to hardcode a
 * conservative default rather than block on missing per-symbol data. Callers
 * that must not silently trade on a placeholder tier should check the
 * returned tier's `source` field themselves (see MarginTier.source).
 *
 * When `positionNotional` exceeds every bracket in the symbol's own table,
 * clamps to the last (highest-risk) tier rather than throwing or
 * extrapolating a tier that doesn't exist — mirrors Bybit's own real
 * behavior at that point (source 4: "once the effective position value ...
 * reaches the risk limit cap, the system will only accept Reduce Only ...
 * orders," i.e. the position sits at the highest tier it already reached,
 * unable to grow further).
 */
export function lookupMarginTier(
  symbol: string,
  positionNotional: Big,
  table: MarginTierTable = KNOWN_MARGIN_TIERS,
): MarginTier {
  if (positionNotional.lte(0)) {
    throw new RangeError(`positionNotional must be positive, got ${positionNotional.toString()}`);
  }

  const tiers = table[symbol];
  if (tiers === undefined || tiers.length === 0) {
    return FALLBACK_CONSERVATIVE_TIER;
  }

  const matched = tiers.find((t) => positionNotional.lte(t.riskLimitValue));
  return matched ?? tiers[tiers.length - 1]!;
}

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

// ---------------------------------------------------------------------------
// Forced-liquidation simulation over a historical mark-price series
// ---------------------------------------------------------------------------

export type PositionSide = "long" | "short";

/**
 * One mark-price observation. Deliberately minimal (not market-data/types.ts's
 * full `SymbolSnapshot`, which also carries orderbook levels, funding, and
 * turnover this simulation doesn't need) but matches that type's own field
 * naming/units convention: `markPrice: Big` (SymbolSnapshot.markPrice) and an
 * epoch-milliseconds timestamp field (SymbolSnapshot.nextFundingTimeMs) — so a
 * caller building this array from market-data/'s stored history does not have
 * to invent new field names or unit conventions for the same underlying data.
 *
 * `markPrice` specifically, not last-traded price: source 1 ("Trading Rules:
 * Liquidation Process") states "Liquidation is triggered by the Mark Price,
 * not the Last Traded Price (LTP)." A caller feeding a last-traded-price
 * series into this simulation would silently mis-time (or entirely miss) a
 * liquidation — this is the one input this module cannot validate for the
 * caller, since a `Big` price alone doesn't say which kind it is.
 */
export interface MarkPriceTick {
  timestampMs: number;
  markPrice: Big;
}

export interface LiquidationSimulationResult {
  wasLiquidated: boolean;
  /** The tick whose markPrice first crossed the liquidation price, if any. */
  liquidationTick?: MarkPriceTick;
  /** Index into the input `ticks` array of `liquidationTick`, if any — for callers that need to slice the series at the liquidation point. */
  liquidationTickIndex?: number;
}

/**
 * Walks `ticks` in order and reports the first tick (if any) whose markPrice
 * reaches or crosses `liquidationPrice` in the direction that liquidates
 * `side` — source 1: "liquidation will be triggered when the Mark Price hits
 * the position's Liquidation Price" (hits, i.e. the boundary itself counts:
 * `>=`/`<=`, not a strict inequality — same inclusive-boundary convention
 * risk/leverage.ts's own `checkAccountMMRate` uses at its own threshold).
 *
 * A SHORT position loses as price rises (liquidation price sits ABOVE entry —
 * see `computeLiquidationPriceShort`'s numerator, entirely `+` terms added to
 * entry×qty), so the crossing direction for `side: "short"` is markPrice
 * reaching UP to `liquidationPrice`; for `side: "long"` it is the mirror,
 * markPrice falling DOWN to it.
 *
 * `ticks` MUST already be sorted ascending by `timestampMs` — this function
 * throws rather than silently re-sorting or returning a wrong "first"
 * crossing, per PROJECT.md ТАБУ #10 ("ни одного проглоченного исключения"):
 * a caller passing an unsorted series has a real bug upstream (e.g. two
 * merged history pages in the wrong order) that a silent sort would hide.
 * Once liquidated, later ticks are never inspected — a real liquidation ends
 * the position, so any subsequent price recovery is irrelevant to whether
 * (and when) forced closure happened.
 */
export function simulateForcedLiquidation(
  ticks: readonly MarkPriceTick[],
  liquidationPrice: Big,
  side: PositionSide,
): LiquidationSimulationResult {
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    if (i > 0 && tick.timestampMs < ticks[i - 1]!.timestampMs) {
      throw new RangeError(
        `ticks must be sorted ascending by timestampMs — tick[${i}].timestampMs=${tick.timestampMs} is before tick[${i - 1}].timestampMs=${ticks[i - 1]!.timestampMs}`,
      );
    }

    const crossed = side === "short" ? tick.markPrice.gte(liquidationPrice) : tick.markPrice.lte(liquidationPrice);
    if (crossed) {
      return { wasLiquidated: true, liquidationTick: tick, liquidationTickIndex: i };
    }
  }

  return { wasLiquidated: false };
}

/**
 * Convenience integration of `computeDeltaNeutralPerpLegLiquidation` and
 * `simulateForcedLiquidation`: given the perp leg's entry/margin parameters
 * and a historical mark-price series, reports whether (and when) the perp
 * leg — and with it, the pair's delta-neutrality (see this module's top-level
 * "SCOPE" doc comment) — would have been forcibly closed. Always simulates
 * `side: "short"`, matching `computeDeltaNeutralPerpLegLiquidation`'s own
 * fixed side.
 *
 * `ticks` should start at/after the position's entry instant — this function
 * does not filter by entry time itself (same "caller scopes the input, this
 * function is a pure per-call computation" convention emulation/equityEngine.ts's
 * own doc comment states explicitly for its own per-tick snapshot function).
 */
export function simulateDeltaNeutralForcedLiquidation(
  ticks: readonly MarkPriceTick[],
  input: DeltaNeutralLiquidationInput,
): LiquidationSimulationResult & { perpLiquidationPrice: Big } {
  const { perpLiquidationPrice } = computeDeltaNeutralPerpLegLiquidation(input);
  const result = simulateForcedLiquidation(ticks, perpLiquidationPrice, "short");
  return { ...result, perpLiquidationPrice };
}
