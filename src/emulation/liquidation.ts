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
 * 8. `src/emulation/marginTierData.json` — a full-universe companion to
 *    source 6 above, not just the two hand-transcribed symbols. Produced by
 *    `src/scripts/fetchMarginTierData.ts` (RISK-REGISTER.md FM-38), a one-off
 *    script that walked the same `GET /v5/market/risk-limit` endpoint for
 *    every symbol in market-data/universe.ts's tradeable universe (live
 *    snapshot captured 2026-08-05/06, corrected 2026-08-06 for a global-vs-
 *    per-symbol `id` numbering bug — see that script's own doc comment).
 *    293/293 symbols covered, including BTCUSDT/ADAUSDT themselves (verified
 *    byte-for-byte identical to KNOWN_MARGIN_TIERS's hand-transcribed rows).
 *    `lookupMarginTier` below loads this file as `FETCHED_MARGIN_TIERS`, a
 *    lower-priority source consulted only for symbols KNOWN_MARGIN_TIERS
 *    doesn't itself cover — see that function's own doc comment.
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
 *
 * This module is now a thin barrel: the implementation was split into
 * `./liquidation/marginTiers.ts` (margin tier data/lookup),
 * `./liquidation/prices.ts` (maintenance margin / bankruptcy price /
 * liquidation price formulas), and `./liquidation/simulate.ts`
 * (forced-liquidation simulation over a mark-price series). All exports below
 * are unchanged in name, type, and behavior — only their file location moved.
 */

export * from "./liquidation/marginTiers.js";
export * from "./liquidation/prices.js";
export * from "./liquidation/simulate.js";
