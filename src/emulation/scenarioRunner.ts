/**
 * Backlog #37/#38 (Фаза 2): the orchestrator that actually RUNS one paper-trading
 * scenario — the piece every other emulation/ module (equityEngine.ts, borrowCost.ts,
 * liquidation.ts, paperPositionState.ts) exists to be plugged into. Reads real
 * historical rows out of tickers/funding_rates/orderbook_levels, decides what a live
 * bot would have decided at each historical instant, and journals the result into
 * paper_positions/paper_fills/paper_funding_payments/paper_equity_snapshots.
 *
 * This file is a thin barrel — the actual implementation lives in
 * ./scenarioRunner/ (types.ts, dbReaders.ts, candidateSelection.ts,
 * positionLifecycle.ts, tickProcessing.ts, orchestrator.ts), split out for
 * file size only. Every symbol below is re-exported unchanged so existing
 * importers (src/scripts/runEmulationScenario.ts, test/emulation/*.test.ts)
 * keep working without modification. The doc comment below (look-ahead
 * discipline, RR-22, documented simplifications) is this MODULE's overview,
 * not just this file's — it applies to every file under ./scenarioRunner/
 * and is referenced from several of them as "module doc comment" / "the
 * barrel's module doc comment".
 *
 * ============================================================================
 * LOOK-AHEAD DISCIPLINE — the single most important property of this file
 * ============================================================================
 * The replay walks discrete instants T taken from the real `tickers.fetched_at`
 * grid (never an invented clock — see `getTickTimestamps`). EVERY query this file
 * issues is bounded `fetched_at <= T` (or, for orderbook_levels, keyed off the
 * latest `fetched_at <= T` snapshot) — a query without that bound would let the
 * replay "see" a row that, at historical instant T, a live bot's collector had not
 * fetched yet.
 *
 * `funding_rates.kind` is the one place this rule gets a documented, deliberate
 * carve-out, because the table encodes two structurally different kinds of fact:
 *   - `kind='predicted'`: what Bybit's ticker endpoint forecasts for the NEXT
 *     settlement, current as of `fetched_at`. This is the ONLY funding data an
 *     entry decision may read — gated the ordinary way, `fetched_at <= T`
 *     (`latestPredictedFundingAtOrBefore`).
 *   - `kind='settled'`: what ACTUALLY happened, recorded via a periodic sweep of
 *     `/v5/market/funding/history` that can run hours or days after the real
 *     settlement instant (`funding_timestamp_ms`) it describes. Gating this table
 *     by `fetched_at <= T` would be WRONG in the opposite direction from the usual
 *     failure — a live bot does not need to wait for that historical-sweep
 *     collector to run before it knows it was paid: Bybit credits/debits funding
 *     directly into account balance the instant a settlement clears, at
 *     `funding_timestamp_ms`, regardless of when (or whether) any history sweep
 *     later records it. So the correct gate for "was this funding payment already
 *     real by time T" is `funding_timestamp_ms <= T` (`settledFundingSince`) — and
 *     `kind='settled'` rows are NEVER consulted for an entry/exit DECISION, only
 *     for crediting funding already economically realized on a position already
 *     open. See `test/emulation/scenarioRunner.test.ts`'s look-ahead fixture: a
 *     settled row can sit in the table from the very start of a scenario, with an
 *     early `funding_timestamp_ms` but a rate that would have justified an entry —
 *     and the entry must still wait for the PREDICTED rate to say so at its own,
 *     later `fetched_at`.
 *
 * ============================================================================
 * MAX ONE POSITION (RR-22)
 * ============================================================================
 * Enforced structurally, not by a counter: the main loop only ever calls
 * `pickBestCandidate` when `openPosition` is `null`. Multiple symbols qualifying
 * at the same tick are ranked by `strategy/rankCandidates.ts` and exactly the
 * top-ranked one is opened — see `test/emulation/scenarioRunner.test.ts`.
 *
 * ============================================================================
 * DOCUMENTED SIMPLIFICATIONS (things the DB schema / docs don't pin down)
 * ============================================================================
 * - `expectedHoldIntervals` (risk/economics.ts's checkEntryThreshold): derived
 *   from PARAMS-CONSERVATIVE.md §5's "круг комиссий должен окупаться за ≤ 3
 *   суток" — 3 days converted into the SYMBOL's own interval count. This matches
 *   test/risk/totalRoundTripCost.test.ts's own RR-24 worked example (9 intervals
 *   for a 480-minute/8h symbol == 3 days / 8h).
 * - `premiumIndexR8h` (risk/index.ts's isPremiumDriven gate): market-data/types.ts's
 *   own SymbolSnapshot.premiumIndexR8h doc comment states Bybit exposes no single
 *   documented "premium index" field, and this schema stores none separately —
 *   the normalized PREDICTED r8h rate itself is used as the proxy.
 * - `isInnovationOrAdventureZone`: not persisted anywhere in this schema (Фаза 1
 *   never collected it). Hardcoded `false` — the caller's `symbols` universe is
 *   assumed pre-curated to exclude those zones, the same assumption
 *   PARAMS-CONSERVATIVE.md §4 makes about the live universe.
 * - `perpQtyStep`: no instruments-info table exists in this schema (Фаза 1 never
 *   persisted it). Falls back to `DEFAULT_PERP_QTY_STEP`, overridable per-symbol
 *   via `ScenarioConfig.perpQtyStepBySymbol`.
 * - Position sizing (`positionSizeUsd`): PARAMS-CONSERVATIVE.md §1-3 says Phase
 *   2-3's position size should equal the eventual real-money size, not scale with
 *   the test deposit — but that real size is still an OPEN parameter (a $200
 *   placeholder), and even $200 against a $500 virtual deposit would exceed §11's
 *   25% concentration cap (200/500 = 40%). Owner's own resolution (2026-08-07):
 *   let the bot decide, adaptively — small with no track record or after a
 *   significant loss, larger after a run of wins. Implemented as
 *   `emulation/adaptivePositionSizing.ts`'s `computeNextPositionSizeFraction`,
 *   folded over this scenario's own closed-trade history so far and applied as
 *   a fraction of CURRENT equity; `positionSizeUsd` still overrides it entirely
 *   with a fixed dollar amount once Phase 4's real size is actually decided.
 * - Entry/exit FILL PRICES are the ticker mark/last price at that tick, not a
 *   book-walked average — the orderbook is still used for the actual RISK checks
 *   (checkEntry's slippage veto, this file's cost estimate) and its resulting
 *   `slippageBp` is charged as an explicit dollar cost via
 *   `realizedPnl.ts`'s `realizedSlippage` input, not folded into the price.
 * - `margin_balance` on paper_equity_snapshots: this schema/docs don't define the
 *   term precisely for a paper account. Approximated as total equity MINUS the
 *   open position's current spot-leg notional — mirroring PARAMS-CONSERVATIVE.md
 *   §1's own observed real account ("BTC и ETH не помечены как залог" — spot
 *   holdings are equity but not usable margin).
 */

export {
  DEFAULT_PERP_QTY_STEP,
  SPOT_TAKER_FEE_RATE_FALLBACK,
  PERP_TAKER_FEE_RATE_FALLBACK,
  HOURLY_BORROW_RATE_FALLBACK,
} from "./scenarioRunner/types.js";
export type { ScenarioConfig, ScenarioRunResult } from "./scenarioRunner/types.js";
export { runScenario } from "./scenarioRunner/orchestrator.js";
