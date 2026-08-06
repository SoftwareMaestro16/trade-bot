import type { Insertable, Kysely } from "kysely";
import type { PublicExchangeClient } from "../exchange/client.js";
import type { RateLimiter } from "../exchange/rateLimiter.js";
import { logger as rootLogger } from "../logger.js";
import type { Database } from "../storage/schema.js";
import type { UniverseSymbol } from "./universe.js";

const logger = rootLogger.child({ module: "collectSettledFunding" });

export interface CollectSettledFundingResult {
  written: number;
  failed: string[];
}

/**
 * FR-100 (historical half). `collectTickers.ts` writes the 'predicted' rate on
 * every cheap batched poll; this is the authoritative counterpart — Bybit's own
 * /v5/market/funding/history record of what actually settled, via
 * `fundingRateTimestamp` (RISK-REGISTER.md FM-04's timestamp-delta inference is a
 * fallback for backfilling raw history without this field, not needed here since
 * the live endpoint reports it directly).
 *
 * Per-symbol, no batch form (GetFundingRateHistoryParamsV5 requires `symbol`), so
 * this is paced through `rateLimiter` like the long/short-ratio sweep.
 *
 * Dedup strategy: the PK on funding_rates is (symbol, kind, fetched_at) — every
 * poll would otherwise write a fresh duplicate row for a settlement that has not
 * changed since the last poll. Instead, the max known `funding_timestamp_ms` per
 * symbol is looked up once (a single grouped query, not per-symbol), and only
 * settlements strictly newer than that are inserted — this is a local DB read as
 * well: cheap. It never re-writes a settlement it has already recorded, and it
 * never needs to know how many cycles have passed since the last poll.
 *
 * Catch-up after downtime: once a symbol has a known max timestamp, the request
 * passes `startTime` (one ms after that max) instead of relying on `limit`
 * alone. Without `startTime`, a plain `limit:5` call always returns only the 5
 * MOST RECENT settlements — if more than 5 were missed (collector down >5h for
 * a 60-min-interval symbol, per RISK-REGISTER.md FM-04's COTIUSDT/ERAUSDT
 * example, or a symbol newly reaching a >5-settlement gap for any other
 * reason), the older-but-still-new ones are silently skipped and never
 * revisited: `knownMax` advances past them the moment the visible 5 are
 * written, permanently orphaning the gap. `startTime` plus a request-max
 * `limit:200` (DECISIONS.md: "200 записей за запрос") closes any realistic
 * gap in one call. The very first poll for a symbol (no `knownMax` yet — new
 * to the universe) keeps the plain `limit:5, no startTime` shape: pagination
 * only goes backward from `endTime` (same source), so a full historical
 * backfill isn't reachable this way regardless — that's a separate, already
 * open question (DECISIONS.md), not something this fix changes.
 *
 * `endTime` is REQUIRED whenever `startTime` is passed — NOT documented in
 * bybit-api's own type (`endTime?: number` looks just as optional as
 * `startTime?: number`), discovered the hard way: a live run with `startTime`
 * alone got `retCode 10001 "params error: Time Is Invalid"` on 100% of
 * symbols, 100% of cycles, for ~2.4 hours straight (silently — this function
 * swallows the real error into a plain `failed.push(symbol)`, and a fully
 * failed sweep still returns normally rather than throwing, so it never
 * touched collection_runs.status). Confirmed directly against the real
 * mainnet endpoint: `startTime` alone → 10001; `startTime`+`endTime` → 0
 * (OK). `endTime` is always `fetchedAt` (this sweep's own "now"), never a
 * fresh `Date.now()` — one consistent instant for the whole cycle.
 */
export async function collectSettledFunding(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
  rateLimiter: RateLimiter,
): Promise<CollectSettledFundingResult> {
  const fetchedAt = new Date();
  const intervalBySymbol = new Map(universe.map((u) => [u.symbol, u.fundingIntervalMinutes]));

  const latestKnown = await db
    .selectFrom("funding_rates")
    .select(["symbol", (eb) => eb.fn.max("funding_timestamp_ms").as("max_ts")])
    .where("kind", "=", "settled")
    .where(
      "symbol",
      "in",
      universe.map((u) => u.symbol),
    )
    .groupBy("symbol")
    .execute();
  const knownMaxBySymbol = new Map(
    latestKnown
      .filter((r): r is typeof r & { max_ts: string } => r.max_ts !== null)
      .map((r) => [r.symbol, BigInt(r.max_ts)]),
  );

  const rows: Insertable<Database["funding_rates"]>[] = [];
  const failed: string[] = [];
  // Logged once per sweep, not once per symbol: a real bug (a malformed
  // request shape rejected by Bybit for every symbol identically — exactly
  // what happened here once, silently, for ~2.4 hours before being noticed)
  // looks the same as ordinary per-symbol flakiness in the `failed` list
  // alone. One real error message per cycle is enough to diagnose either
  // case without spamming ~293 near-duplicate lines when it's systemic.
  let loggedFirstError = false;

  for (const { symbol } of universe) {
    try {
      const knownMax = knownMaxBySymbol.get(symbol) ?? null;
      const response = await rateLimiter.schedule(() =>
        // See this module's own doc comment: startTime+limit:200 when we have a
        // known baseline to catch up FROM, plain limit:5 only on a symbol's
        // very first poll (no baseline to catch up from at all).
        knownMax !== null
          ? client.getFundingRateHistory({
              category: "linear",
              symbol,
              startTime: Number(knownMax + 1n),
              endTime: fetchedAt.getTime(),
              limit: 200,
            })
          : client.getFundingRateHistory({ category: "linear", symbol, limit: 5 }),
      );
      const intervalMinutes = intervalBySymbol.get(symbol);
      if (intervalMinutes === undefined) continue; // symbol not in this cycle's universe map

      for (const entry of response.result.list) {
        const ts = BigInt(entry.fundingRateTimestamp);
        if (knownMax !== null && ts <= knownMax) continue;
        rows.push({
          symbol: entry.symbol,
          kind: "settled",
          rate: entry.fundingRate,
          interval_minutes: intervalMinutes,
          funding_timestamp_ms: entry.fundingRateTimestamp,
          fetched_at: fetchedAt,
        });
      }
    } catch (e) {
      if (!loggedFirstError) {
        loggedFirstError = true;
        logger.error({ err: e, symbol }, "first failure this cycle");
      }
      failed.push(symbol);
    }
  }

  if (rows.length > 0) {
    await db.insertInto("funding_rates").values(rows).execute();
  }

  return { written: rows.length, failed };
}
