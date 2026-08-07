import Big from "big.js";
import type { Kysely } from "kysely";
import { latestLongShortRatioAtOrBefore } from "../../market-data/collectLongShortRatio.js";
import type { Database } from "../../storage/schema.js";
import type {
  LiquidationSample,
  LongShortRatioSample,
  OpenInterestSample,
  SettledFundingSample,
} from "../episodeFeatures.js";

// Split out of predictive/episodeExtraction.ts — see episodeExtraction/extract.ts's
// module doc comment for full context (look-ahead discipline, episode definition,
// label window). This file holds the feature-window DB reads only.

export async function fetchOpenInterestWindow(
  db: Kysely<Database>,
  symbol: string,
  episodeStartMs: number,
  windowHours: number,
): Promise<OpenInterestSample[]> {
  const windowStart = new Date(episodeStartMs - windowHours * 60 * 60 * 1000);
  const episodeStart = new Date(episodeStartMs);
  const rows = await db
    .selectFrom("open_interest")
    .select(["open_interest", "fetched_at"])
    .where("symbol", "=", symbol)
    .where("fetched_at", ">=", windowStart)
    .where("fetched_at", "<=", episodeStart)
    .execute();
  return rows.map((r) => ({ timestampMs: r.fetched_at.getTime(), openInterest: new Big(r.open_interest) }));
}

/** Latest-at-or-before-episode-start reading — thin ms-to-Date wrapper around `market-data/collectLongShortRatio.ts`'s shared `latestLongShortRatioAtOrBefore`, same one `scenarioRunner.ts` uses. Context-only, gated the ordinary `fetched_at <= T` way. */
export async function fetchLongShortRatioAtStart(
  db: Kysely<Database>,
  symbol: string,
  episodeStartMs: number,
): Promise<LongShortRatioSample | undefined> {
  return latestLongShortRatioAtOrBefore(db, symbol, new Date(episodeStartMs));
}

export async function fetchLiquidationWindow(
  db: Kysely<Database>,
  symbol: string,
  episodeStartMs: number,
  windowHours: number,
): Promise<LiquidationSample[]> {
  const windowStart = new Date(episodeStartMs - windowHours * 60 * 60 * 1000);
  const episodeStart = new Date(episodeStartMs);
  const rows = await db
    .selectFrom("liquidations")
    .select(["side", "size", "price", "received_at"])
    .where("symbol", "=", symbol)
    .where("received_at", ">=", windowStart)
    .where("received_at", "<=", episodeStart)
    .execute();
  return rows.map((r) => ({
    timestampMs: r.received_at.getTime(),
    side: r.side,
    size: new Big(r.size),
    price: new Big(r.price),
  }));
}

/** See module doc comment point 3 — gated by `funding_timestamp_ms`, deliberately NOT `fetched_at`. */
export async function fetchFundingVolatilityHistory(
  db: Kysely<Database>,
  symbol: string,
  episodeStartMs: number,
  windowHours: number,
): Promise<SettledFundingSample[]> {
  const windowStartMs = episodeStartMs - windowHours * 60 * 60 * 1000;
  const rows = await db
    .selectFrom("funding_rates")
    .select(["rate", "interval_minutes", "funding_timestamp_ms"])
    .where("symbol", "=", symbol)
    .where("kind", "=", "settled")
    .where("funding_timestamp_ms", ">=", String(windowStartMs))
    .where("funding_timestamp_ms", "<", String(episodeStartMs))
    .execute();
  return rows.map((r) => ({
    fundingTimestampMs: Number(r.funding_timestamp_ms),
    intervalMinutes: r.interval_minutes,
    rate: new Big(r.rate),
  }));
}
