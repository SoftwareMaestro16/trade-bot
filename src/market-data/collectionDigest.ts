import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";

export interface DigestStats {
  windowStart: Date;
  windowEnd: Date;
  universeSize: number;
  tickersWritten: number;
  fundingRatesWritten: number;
  openInterestWritten: number;
  longShortRatioWritten: number;
  orderbookLevelsWritten: number;
  liquidationsWritten: number;
  collectionRunsCompleted: number;
  collectionRunsFailed: number;
  lastRunAt: Date | null;
  recentFailures: { startedAt: Date; error: string | null }[];
}

/**
 * Feeds the twice-daily Telegram digest (12:00/20:00) requested to confirm
 * the collector is alive and doing something, without opening a terminal —
 * this is deliberately row COUNTS per table, not a correctness check: it
 * answers "is data arriving", which is what FR-109 continuity monitoring is
 * about at this stage, not "is the data good" (that's Phase 1's actual exit
 * criterion analysis, done once, at the end of the two weeks).
 */
export async function computeDigestStats(
  db: Kysely<Database>,
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestStats> {
  const [
    universeRow,
    tickersRow,
    fundingRow,
    oiRow,
    lsrRow,
    obRow,
    liqRow,
    runsRow,
    lastRunRow,
    failures,
  ] = await Promise.all([
    db
      .selectFrom("tickers")
      .select(({ fn }) => fn.count<string>("symbol").distinct().as("count"))
      .where("fetched_at", ">=", windowStart)
      .where("fetched_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("tickers")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("fetched_at", ">=", windowStart)
      .where("fetched_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("funding_rates")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("fetched_at", ">=", windowStart)
      .where("fetched_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("open_interest")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("fetched_at", ">=", windowStart)
      .where("fetched_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("long_short_ratio")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("fetched_at", ">=", windowStart)
      .where("fetched_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("orderbook_levels")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("fetched_at", ">=", windowStart)
      .where("fetched_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("liquidations")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("received_at", ">=", windowStart)
      .where("received_at", "<", windowEnd)
      .executeTakeFirst(),
    db
      .selectFrom("collection_runs")
      .select(["status", ({ fn }) => fn.countAll<string>().as("count")])
      .where("started_at", ">=", windowStart)
      .where("started_at", "<", windowEnd)
      .groupBy("status")
      .execute(),
    db
      .selectFrom("collection_runs")
      .select("started_at")
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom("collection_runs")
      .select(["started_at", "error"])
      .where("status", "=", "failed")
      .where("started_at", ">=", windowStart)
      .where("started_at", "<", windowEnd)
      .orderBy("started_at", "desc")
      .limit(5)
      .execute(),
  ]);

  const completed = runsRow.find((r) => r.status === "completed")?.count;
  const failed = runsRow.find((r) => r.status === "failed")?.count;

  return {
    windowStart,
    windowEnd,
    universeSize: Number(universeRow?.count ?? 0),
    tickersWritten: Number(tickersRow?.count ?? 0),
    fundingRatesWritten: Number(fundingRow?.count ?? 0),
    openInterestWritten: Number(oiRow?.count ?? 0),
    longShortRatioWritten: Number(lsrRow?.count ?? 0),
    orderbookLevelsWritten: Number(obRow?.count ?? 0),
    liquidationsWritten: Number(liqRow?.count ?? 0),
    collectionRunsCompleted: Number(completed ?? 0),
    collectionRunsFailed: Number(failed ?? 0),
    lastRunAt: lastRunRow?.started_at ?? null,
    recentFailures: failures.map((f) => ({ startedAt: f.started_at, error: f.error })),
  };
}
