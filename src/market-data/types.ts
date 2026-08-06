import type Big from "big.js";

/**
 * Shared candidate-evaluation shape consumed by strategy/ and risk/ pure
 * functions. Lives in market-data/ (not strategy/ or risk/) because it
 * describes what market-data/ produces from live API responses — both
 * downstream modules may depend on this module's types without conflicting
 * with the strategy/ -> exchange/,execution/ import boundary (NFR-11), which
 * restricts strategy/'s outgoing imports, not incoming type dependencies on
 * market-data/.
 *
 * All money/rate fields are `Big`, never `number` or raw `string` — parsing
 * exchange strings into Big is the caller's job, at the market-data/exchange
 * boundary, before this shape is constructed (ADR-003).
 */

export interface OrderbookLevel {
  price: Big;
  qty: Big;
}

export interface SymbolSnapshot {
  symbol: string;

  /** From instruments-info.fundingInterval, read live — never cached beyond one cycle (RSK-25). */
  fundingIntervalMinutes: number;

  /** Current per-interval predicted funding rate (ticker.fundingRate), NOT yet normalized to r8h. */
  fundingRate: Big;

  /**
   * Premium index component of the funding rate, normalized to an 8h basis.
   * RISK-REGISTER.md FM-01 gates entry on this exceeding +0.05%/8h — Bybit does
   * not expose a single documented "premium index" field on the V5 ticker
   * (basisRate/basis were observed empty on many symbols during Phase 1's live
   * checks); deriving this value (e.g. from markPrice vs indexPrice divergence,
   * or from Bybit's premium-index kline endpoint) is an open point for whoever
   * wires market-data/ into this shape — NOT solved by this type or by the
   * functions consuming it.
   */
  premiumIndexR8h: Big;

  nextFundingTimeMs: number;

  markPrice: Big;
  spotMidPrice: Big;

  perpTurnover24h: Big;
  spotTurnover24h: Big;

  /** Top-of-book-and-deeper levels, best price first. From orderbook_levels (FR-104). */
  perpBids: OrderbookLevel[];
  perpAsks: OrderbookLevel[];
  spotBids: OrderbookLevel[];
  spotAsks: OrderbookLevel[];

  /** PARAMS-CONSERVATIVE.md §4: Innovation/Adventure Zone symbols are excluded entirely. */
  isInnovationOrAdventureZone: boolean;
}
