import Big from "big.js";
import type { Insertable } from "kysely";
import { pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import { PublicExchangeClient } from "../exchange/client.js";
import { RateLimiter } from "../exchange/rateLimiter.js";
import { normalizeFundingRateToR8h } from "../market-data/normalizeFunding.js";
import { computeTradeableUniverse } from "../market-data/universe.js";
import { createDb } from "../storage/db.js";
import type { Database } from "../storage/schema.js";

/**
 * One-off, manually-run script — NOT part of collector.ts's regular schedule,
 * NOT a permanent collector. Owner's own framing: "то что можно компенсируй,
 * остальное добирать будем" — of the 6 Phase 1 data types, only settled
 * funding rate (plus open_interest/long_short_ratio, not covered here)
 * supports historical backfill at all; orderbook_levels and liquidations do
 * not exist historically on Bybit's API at any price (see PHASE-LOG.md /
 * conversation 2026-08-06). This script exists ONLY to give an early,
 * preliminary read on the funding-rate signal itself — NOT to shorten
 * Phase 1's actual exit criteria, which still depend on the orderbook/
 * liquidation data that can only accumulate live.
 *
 * Run once via: node --env-file=.env dist/scripts/backfillFundingHistory.js
 * (after `npm run build`). Safe to re-run — the existingKeys check below
 * makes it idempotent against real duplicate settlements, even though the
 * funding_rates PK (symbol, kind, funding_timestamp_ms, fetched_at) would
 * NOT itself reject a re-inserted duplicate under a different fetched_at.
 */

const BACKFILL_DAYS = 14;
const CALL_SPACING_MS = 150; // matches collectSettledFunding.ts's own NFR-04 spacing
const MAX_PAGES_PER_SYMBOL = 5; // 5*200=1000 records — covers even a 60min-interval symbol's ~336 settlements over 14 days with room to spare
const INSERT_CHUNK_SIZE = 1000;

// Mirrors risk/economics.ts's own ENTRY_FLOOR_R8H (PARAMS-CONSERVATIVE.md §5:
// 0.020%/8h). Duplicated here, not imported: that constant isn't exported
// from risk/economics.ts, and this script isn't part of the risk/ module
// graph — it exists only to print a rough "does this signal look promising"
// summary, never to gate a real entry decision.
const ENTRY_FLOOR_R8H = new Big("0.0002");

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const client = new PublicExchangeClient({ testnet: false });
  const limiter = new RateLimiter(CALL_SPACING_MS);
  const fetchedAt = new Date();
  const startBoundaryMs = fetchedAt.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;

  console.log("[backfill] computing universe...");
  const universe = await computeTradeableUniverse(client);
  console.log(`[backfill] ${universe.length} symbols, window: last ${String(BACKFILL_DAYS)} days`);

  // Guards against a re-run inserting the same real-world settlement twice
  // under a different fetched_at (see module doc comment above).
  const existingRows = await db
    .selectFrom("funding_rates")
    .select(["symbol", "funding_timestamp_ms"])
    .where("kind", "=", "settled")
    .where(
      "symbol",
      "in",
      universe.map((u) => u.symbol),
    )
    .execute();
  const existingKeys = new Set(existingRows.map((r) => `${r.symbol}|${r.funding_timestamp_ms}`));
  console.log(`[backfill] ${existingKeys.size} settled rows already on file for this universe`);

  const newRows: Insertable<Database["funding_rates"]>[] = [];
  const failed: string[] = [];
  const signalCounts = new Map<string, number>(); // symbol -> settlements at/above the entry floor

  for (const { symbol, fundingIntervalMinutes } of universe) {
    try {
      let endTime = fetchedAt.getTime();
      let page = 0;
      let reachedBoundary = false;

      while (page < MAX_PAGES_PER_SYMBOL && !reachedBoundary) {
        const response = await limiter.schedule(() =>
          client.getFundingRateHistory({
            category: "linear",
            symbol,
            startTime: startBoundaryMs,
            endTime,
            limit: 200,
          }),
        );
        const list = response.result.list;
        if (list.length === 0) break;

        for (const entry of list) {
          const key = `${symbol}|${entry.fundingRateTimestamp}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key); // also guards against double-counting across this run's own pages
          newRows.push({
            symbol: entry.symbol,
            kind: "settled",
            rate: entry.fundingRate,
            interval_minutes: fundingIntervalMinutes,
            funding_timestamp_ms: entry.fundingRateTimestamp,
            fetched_at: fetchedAt,
          });

          const r8h = normalizeFundingRateToR8h(new Big(entry.fundingRate).abs(), fundingIntervalMinutes);
          if (r8h.gte(ENTRY_FLOOR_R8H)) {
            signalCounts.set(symbol, (signalCounts.get(symbol) ?? 0) + 1);
          }
        }

        const oldestTsMs = Math.min(...list.map((e) => Number(e.fundingRateTimestamp)));
        if (list.length < 200 || oldestTsMs <= startBoundaryMs) {
          reachedBoundary = true;
        } else {
          endTime = oldestTsMs - 1;
        }
        page++;
      }
    } catch (e) {
      failed.push(symbol);
      console.error(`[backfill] ${symbol} failed:`, e instanceof Error ? e.message : e);
    }
  }

  if (newRows.length > 0) {
    for (let i = 0; i < newRows.length; i += INSERT_CHUNK_SIZE) {
      await db
        .insertInto("funding_rates")
        .values(newRows.slice(i, i + INSERT_CHUNK_SIZE))
        .execute();
    }
  }

  console.log(`\n[backfill] inserted ${String(newRows.length)} new settled funding rows`);
  if (failed.length > 0) console.log(`[backfill] ${String(failed.length)} symbols failed: ${failed.join(", ")}`);

  const ranked = [...signalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(
    `\n[backfill] preliminary signal — top 15 symbols by settlements at/above the ${ENTRY_FLOOR_R8H.toString()} r8h entry floor, last ${String(BACKFILL_DAYS)} days:`,
  );
  for (const [symbol, count] of ranked) {
    console.log(`  ${symbol}: ${String(count)}`);
  }
  const totalAboveFloor = [...signalCounts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\n[backfill] total settlements at/above floor: ${String(totalAboveFloor)} / ${String(newRows.length + existingRows.length)} across ${String(universe.length)} symbols`,
  );

  await db.destroy();
}

// Guards against main() running as a side effect of importing this module
// (a future test, an editor's type-checking import graph, etc.) — only a
// direct `node .../backfillFundingHistory.js` invocation satisfies this,
// matching runEmulationScenario.ts's/exportPredictiveTrainingDataset.ts's/
// fetchMarginTierData.ts's own identical guard. Without it, any import would
// trigger a real Bybit network sweep and real DB writes.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exit(1);
  });
}
