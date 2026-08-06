import type { Insertable, Kysely } from "kysely";
import type { PublicExchangeClient } from "../exchange/client.js";
import type { Database } from "../storage/schema.js";
import type { UniverseSymbol } from "./universe.js";

export interface CollectTickersResult {
  tickersWritten: number;
  fundingRatesWritten: number;
  openInterestWritten: number;
  /**
   * Count of universe SYMBOLS (not rows) that got BOTH a linear and a spot
   * ticker row this cycle — the number FR-109 gap detection should compare
   * against `symbolsExpected`. Deliberately NOT `tickersWritten`: that's a row
   * count (up to 2 rows/symbol), so a cycle missing half its spot responses
   * still reports what looks like near-full coverage under the row count,
   * silently masking exactly the partial gap FR-109 exists to catch.
   */
  symbolsCollected: number;
}

/**
 * FR-102/FR-103/FR-105 (partial): one batched call per category picks up prices,
 * basis inputs, predicted funding, AND current open interest in a single response —
 * Bybit's linear ticker carries `fundingRate`/`nextFundingTime`/`openInterest`
 * directly (verified against node_modules/bybit-api's TickerLinearInverseV5 type),
 * so this alone covers most of the base layer without any per-symbol call.
 *
 * Deliberately NOT used here: `fundingIntervalHour` from the ticker payload. The
 * authoritative interval is the one already read from instruments-info into the
 * universe (RSK-25) — reusing it here keeps a single source of truth instead of
 * trusting two endpoints to agree.
 *
 * What this function does NOT cover (separate, per-symbol, paced collectors —
 * not yet built): the 'settled' funding_rates rows from /v5/market/funding/history,
 * long/short ratio, orderbook snapshots, and the liquidation WS stream.
 */
export async function collectTickers(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
): Promise<CollectTickersResult> {
  const fetchedAt = new Date();
  const universeSymbols = new Map(universe.map((u) => [u.symbol, u]));

  const [linearResponse, spotResponse] = await Promise.all([
    client.getTickersLinear({ category: "linear" }),
    client.getTickersSpot({ category: "spot" }),
  ]);

  const tickerRows: Insertable<Database["tickers"]>[] = [];
  const fundingRateRows: Insertable<Database["funding_rates"]>[] = [];
  const openInterestRows: Insertable<Database["open_interest"]>[] = [];
  const linearSymbols = new Set<string>();
  const spotSymbols = new Set<string>();

  for (const t of linearResponse.result.list) {
    const universeEntry = universeSymbols.get(t.symbol);
    if (!universeEntry) continue; // FR-108: outside the tradeable intersection.
    linearSymbols.add(t.symbol);

    tickerRows.push({
      symbol: t.symbol,
      category: "linear",
      last_price: t.lastPrice,
      mark_price: t.markPrice,
      index_price: t.indexPrice,
      volume_24h: t.volume24h,
      turnover_24h: t.turnover24h,
      fetched_at: fetchedAt,
    });

    fundingRateRows.push({
      symbol: t.symbol,
      kind: "predicted",
      rate: t.fundingRate,
      interval_minutes: universeEntry.fundingIntervalMinutes,
      funding_timestamp_ms: t.nextFundingTime,
      fetched_at: fetchedAt,
    });

    openInterestRows.push({
      symbol: t.symbol,
      open_interest: t.openInterest,
      data_period: "ticker",
      data_timestamp_ms: String(fetchedAt.getTime()),
      fetched_at: fetchedAt,
    });
  }

  for (const t of spotResponse.result.list) {
    if (!universeSymbols.has(t.symbol)) continue;
    spotSymbols.add(t.symbol);

    tickerRows.push({
      symbol: t.symbol,
      category: "spot",
      last_price: t.lastPrice,
      mark_price: null,
      index_price: null,
      volume_24h: t.volume24h,
      turnover_24h: t.turnover24h,
      fetched_at: fetchedAt,
    });
  }

  if (tickerRows.length > 0) {
    await db.insertInto("tickers").values(tickerRows).execute();
  }
  if (fundingRateRows.length > 0) {
    await db.insertInto("funding_rates").values(fundingRateRows).execute();
  }
  if (openInterestRows.length > 0) {
    await db.insertInto("open_interest").values(openInterestRows).execute();
  }

  let symbolsCollected = 0;
  for (const s of linearSymbols) {
    if (spotSymbols.has(s)) symbolsCollected++;
  }

  return {
    tickersWritten: tickerRows.length,
    fundingRatesWritten: fundingRateRows.length,
    openInterestWritten: openInterestRows.length,
    symbolsCollected,
  };
}
