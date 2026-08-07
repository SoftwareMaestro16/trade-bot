import Big from "big.js";
import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import type { OrderbookLevel } from "../../market-data/types.js";
import type { TickerSnapshot, PredictedFunding, SettledFunding } from "./types.js";

/**
 * scenarioRunner split (mechanical refactor): DB read helpers — every one
 * bounded `fetched_at <= T` (see the barrel's module doc comment,
 * ../../emulation/scenarioRunner.ts, for the full "LOOK-AHEAD DISCIPLINE"
 * section this section's rows all obey).
 */

// ---------------------------------------------------------------------------
// DB read helpers — every one bounded `fetched_at <= T` (see module doc comment)
// ---------------------------------------------------------------------------

export async function getTickTimestamps(db: Kysely<Database>, start: Date, end: Date): Promise<Date[]> {
  const rows = await db
    .selectFrom("tickers")
    .select("fetched_at")
    .distinct()
    .where("fetched_at", ">=", start)
    .where("fetched_at", "<=", end)
    .orderBy("fetched_at", "asc")
    .execute();
  return rows.map((r) => r.fetched_at);
}

export async function latestTickerAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  category: "linear" | "spot",
  t: Date,
): Promise<TickerSnapshot | undefined> {
  const row = await db
    .selectFrom("tickers")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("category", "=", category)
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    lastPrice: new Big(row.last_price),
    markPrice: row.mark_price !== null ? new Big(row.mark_price) : null,
    turnover24h: row.turnover_24h !== null ? new Big(row.turnover_24h) : new Big(0),
  };
}

export async function latestPredictedFundingAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  t: Date,
): Promise<PredictedFunding | undefined> {
  const row = await db
    .selectFrom("funding_rates")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("kind", "=", "predicted")
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    rate: new Big(row.rate),
    intervalMinutes: row.interval_minutes,
    nextFundingTimeMs: Number(row.funding_timestamp_ms),
  };
}

/**
 * kind='settled' rows, gated by `funding_timestamp_ms` (the real settlement
 * instant), NOT `fetched_at` (when the historical-sweep collector happened to
 * record it) — see module doc comment's "LOOK-AHEAD DISCIPLINE" section for why
 * this is the one deliberate exception to the usual `fetched_at <= T` rule.
 */
export async function settledFundingSince(
  db: Kysely<Database>,
  symbol: string,
  afterMsExclusive: number,
  uptoMsInclusive: number,
): Promise<SettledFunding[]> {
  const rows = await db
    .selectFrom("funding_rates")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("kind", "=", "settled")
    .where("funding_timestamp_ms", ">", String(afterMsExclusive))
    .where("funding_timestamp_ms", "<=", String(uptoMsInclusive))
    .orderBy("funding_timestamp_ms", "asc")
    .execute();
  return rows.map((r) => ({
    rate: new Big(r.rate),
    intervalMinutes: r.interval_minutes,
    fundingTimestampMs: Number(r.funding_timestamp_ms),
  }));
}

export async function orderbookSideAtOrBefore(
  db: Kysely<Database>,
  symbol: string,
  category: "linear" | "spot",
  side: "bid" | "ask",
  t: Date,
): Promise<OrderbookLevel[]> {
  const maxRow = await db
    .selectFrom("orderbook_levels")
    .select(({ fn }) => fn.max("fetched_at").as("maxFetchedAt"))
    .where("symbol", "=", symbol)
    .where("category", "=", category)
    .where("side", "=", side)
    .where("fetched_at", "<=", t)
    .executeTakeFirst();
  if (!maxRow || maxRow.maxFetchedAt === null) return [];

  const rows = await db
    .selectFrom("orderbook_levels")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("category", "=", category)
    .where("side", "=", side)
    .where("fetched_at", "=", maxRow.maxFetchedAt)
    .orderBy("level_index", "asc")
    .execute();
  return rows.map((r) => ({ price: new Big(r.price), qty: new Big(r.qty) }));
}

/**
 * Context-only market data for entry_reasoning (owner's ask, 2026-08-06: "что
 * происходило на рынке" at decision time) — same `fetched_at <= t` gate as
 * every other read in this file, but unlike latestPredictedFundingAtOrBefore
 * a missing row here does NOT veto the candidate: open_interest is collected
 * separately from tickers/funding_rates (collectOpenInterest.ts) and can
 * simply not have run yet for a given symbol/instant without that meaning
 * anything about whether the trade itself is sound.
 */
export async function latestOpenInterestAtOrBefore(db: Kysely<Database>, symbol: string, t: Date): Promise<Big | undefined> {
  const row = await db
    .selectFrom("open_interest")
    .selectAll()
    .where("symbol", "=", symbol)
    .where("fetched_at", "<=", t)
    .orderBy("fetched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return new Big(row.open_interest);
}
