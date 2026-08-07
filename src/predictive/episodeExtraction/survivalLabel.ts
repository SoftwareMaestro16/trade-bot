import Big from "big.js";
import type { Kysely } from "kysely";
import { normalizeFundingRateToR8h } from "../../market-data/normalizeFunding.js";
import { ENTRY_FLOOR_R8H } from "../../risk/economics.js";
import type { Database } from "../../storage/schema.js";

// Split out of predictive/episodeExtraction.ts — see episodeExtraction/extract.ts's
// module doc comment for full context (look-ahead discipline, episode definition,
// label window). This file holds the forward-looking survival-label computation only.

/**
 * See module doc comment's "LABEL WINDOW AND RIGHT-CENSORING" section.
 * Returns `undefined` (not a boolean) when the outcome can't be determined
 * from data on file — caller must drop the episode, never default it.
 */
export async function computeSurvivalLabel(
  db: Kysely<Database>,
  symbol: string,
  afterMsExclusive: number,
  uptoMsInclusive: number,
): Promise<boolean | undefined> {
  const rows = await db
    .selectFrom("funding_rates")
    .select(["rate", "interval_minutes", "funding_timestamp_ms"])
    .where("symbol", "=", symbol)
    .where("kind", "=", "settled")
    .where("funding_timestamp_ms", ">", String(afterMsExclusive))
    .where("funding_timestamp_ms", "<=", String(uptoMsInclusive))
    .orderBy("funding_timestamp_ms", "asc")
    .execute();

  if (rows.length === 0) {
    // The caller's coverage check (max settled funding_timestamp_ms for the
    // symbol reaches past uptoMsInclusive) only proves the collector
    // eventually got past this window in time — it does not prove every
    // settlement WITHIN the window was actually recorded (a collector gap
    // is possible). Zero rows here means the true outcome is unknowable from
    // this data, same treatment as the right-censored case.
    return undefined;
  }

  // A non-empty row set can STILL be a partial, mid-window gap (same
  // collector-gap mechanism as above, e.g. collectSettledFunding.ts's
  // documented `limit:5` first-poll truncation) — some but not all expected
  // settlements present, which must not silently read as "every present row
  // is above floor, so survived". Walk the settlements in order and check
  // each one's own `interval_minutes` says the next settlement was due no
  // later than the following row (or, for the last row, the window's own
  // inclusive end) — a due-but-missing settlement means unknowable, exactly
  // like the zero-rows case above.
  let previousMs = afterMsExclusive;
  for (const row of rows) {
    const fundingTimestampMs = Number(row.funding_timestamp_ms);
    const intervalMs = row.interval_minutes * 60 * 1000;
    if (fundingTimestampMs - previousMs > intervalMs) return undefined;
    previousMs = fundingTimestampMs;
  }
  const tailIntervalMs = rows[rows.length - 1]!.interval_minutes * 60 * 1000;
  if (uptoMsInclusive - previousMs >= tailIntervalMs) return undefined;

  return rows.every((r) => normalizeFundingRateToR8h(new Big(r.rate), r.interval_minutes).gte(ENTRY_FLOOR_R8H));
}
