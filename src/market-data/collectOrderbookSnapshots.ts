import type { Insertable, Kysely } from "kysely";
import type { PublicExchangeClient } from "../exchange/client.js";
import type { RateLimiter } from "../exchange/rateLimiter.js";
import { logger as rootLogger } from "../logger.js";
import type { Database } from "../storage/schema.js";
import type { UniverseSymbol } from "./universe.js";

const logger = rootLogger.child({ module: "collectOrderbookSnapshots" });

export interface CollectOrderbookSnapshotsResult {
  written: number;
  /** `${symbol}:${category}` entries — up to 2 per symbol (linear + spot). */
  failed: string[];
  /**
   * Count of universe SYMBOLS (not `failed` entries) with BOTH categories
   * collected this cycle — the number FR-109 gap detection should compare
   * against `symbolsExpected`. `failed.length` is not that number: it's a
   * (symbol, category) count that can run up to 2x the symbol count, so
   * deriving "collected" as `universe.length - failed.length` can go negative
   * and always undercounts real per-symbol coverage.
   */
  symbolsCollected: number;
}

const INSERT_CHUNK_SIZE = 1000;

/**
 * FR-104 / PARAMS-CONSERVATIVE.md §1: top-50 snapshots, not the full delta stream —
 * the full stream is the single most expensive thing this project could store
 * (infra ADR in DECISIONS.md), and Phase 1 only needs enough depth to estimate
 * slippage (RISK-REGISTER.md FM-03), not a perfectly reconstructed live book.
 *
 * Both categories are swept per symbol: FM-03's finding that the SPOT book is
 * usually the binding constraint on slippage does not mean the PERP book is
 * unneeded — FR-104 covers both, and the two are cheap to collect together since
 * they already share the per-symbol rate-limited loop.
 *
 * Normalized into rows (symbol, category, side, level_index) rather than a
 * jsonb array — NFR-03: numbers inside jsonb come back as float through the
 * driver's JSON.parse, which is exactly the failure mode ADR-003 forbids.
 */
export async function collectOrderbookSnapshots(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
  rateLimiter: RateLimiter,
  depth: 1 | 50 | 200 | 500 = 50,
): Promise<CollectOrderbookSnapshotsResult> {
  const fetchedAt = new Date();
  const rows: Insertable<Database["orderbook_levels"]>[] = [];
  const failed: string[] = [];
  // Logged once per sweep, not once per (symbol,category): a systemic bug
  // (every call rejected identically) looks the same as ordinary flakiness in
  // the `failed` list alone — a real incident in a sibling collector
  // (collectSettledFunding.ts) went unnoticed for ~2.4 hours specifically
  // because its equivalent catch block swallowed the real error entirely.
  let loggedFirstError = false;

  for (const { symbol } of universe) {
    for (const category of ["linear", "spot"] as const) {
      try {
        const response = await rateLimiter.schedule(() =>
          client.getOrderbook({ category, symbol, limit: depth }),
        );
        response.result.b.forEach(([price, qty], levelIndex) => {
          rows.push({ symbol, category, side: "bid", level_index: levelIndex, price, qty, fetched_at: fetchedAt });
        });
        response.result.a.forEach(([price, qty], levelIndex) => {
          rows.push({ symbol, category, side: "ask", level_index: levelIndex, price, qty, fetched_at: fetchedAt });
        });
      } catch (e) {
        if (!loggedFirstError) {
          loggedFirstError = true;
          logger.error({ err: e, symbol, category }, "first failure this cycle");
        }
        failed.push(`${symbol}:${category}`);
      }
    }
  }

  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    await db.insertInto("orderbook_levels").values(rows.slice(i, i + INSERT_CHUNK_SIZE)).execute();
  }

  const failedSymbols = new Set(failed.map((f) => f.split(":")[0]));
  const symbolsCollected = universe.length - failedSymbols.size;

  return { written: rows.length, failed, symbolsCollected };
}
