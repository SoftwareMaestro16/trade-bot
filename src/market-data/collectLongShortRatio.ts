import type { Kysely } from "kysely";
import type { OpenInterestIntervalV5 } from "bybit-api";
import type { PublicExchangeClient } from "../exchange/client.js";
import type { RateLimiter } from "../exchange/rateLimiter.js";
import { logger as rootLogger } from "../logger.js";
import type { Database } from "../storage/schema.js";
import type { UniverseSymbol } from "./universe.js";

const logger = rootLogger.child({ module: "collectLongShortRatio" });

export interface CollectLongShortRatioResult {
  written: number;
  failed: string[];
}

/**
 * FR-106. No batch form exists on Bybit for this endpoint (verified against
 * GetLongShortRatioParamsV5 — `symbol` is required, not optional), so this is a
 * genuine per-symbol sweep and MUST go through the caller-supplied RateLimiter
 * (NFR-04) — a bare `for` loop here would burst 234 requests with no spacing.
 *
 * One symbol failing (timeout, delisted mid-sweep, etc.) does not abort the sweep —
 * RISK-REGISTER.md's collection-continuity concern (FM-19/FR-109) is about the
 * whole cycle staying alive, not about any single symbol being perfect.
 */
export async function collectLongShortRatio(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
  rateLimiter: RateLimiter,
  period: OpenInterestIntervalV5 = "5min",
): Promise<CollectLongShortRatioResult> {
  const fetchedAt = new Date();
  const rows: {
    symbol: string;
    buy_ratio: string;
    sell_ratio: string;
    data_period: string;
    data_timestamp_ms: string;
    fetched_at: Date;
  }[] = [];
  const failed: string[] = [];
  // See collectSettledFunding.ts's identical comment: logged once per sweep,
  // not once per symbol, so a systemic failure (every call rejected
  // identically) is diagnosable from a single log line instead of being
  // indistinguishable from ordinary per-symbol flakiness in `failed` alone.
  let loggedFirstError = false;

  for (const { symbol } of universe) {
    try {
      const response = await rateLimiter.schedule(() =>
        client.getLongShortRatio({ category: "linear", symbol, period, limit: 1 }),
      );
      const latest = response.result.list[0];
      if (latest) {
        rows.push({
          symbol: latest.symbol,
          buy_ratio: latest.buyRatio,
          sell_ratio: latest.sellRatio,
          data_period: period,
          data_timestamp_ms: latest.timestamp,
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
    await db.insertInto("long_short_ratio").values(rows).execute();
  }

  return { written: rows.length, failed };
}
