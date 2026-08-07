import type { Kysely } from "kysely";
import type { FreshnessCheck } from "../notify/healthcheck.js";
import type { Database } from "../storage/schema.js";

/**
 * Extracted verbatim from collector.ts main()'s `if (env.HEALTHCHECK_PING_URL)`
 * block — builds the four FreshnessCheck entries passed to startHeartbeat.
 * See notify/healthcheck.ts's own doc comment for why these four checks (not
 * six, not one) are exactly the independently-scheduled write paths worth
 * gating the ping on. `dbStaleAfterMs`/`slowStreamStaleAfterMs`/
 * `settledFundingStaleAfterMs` are collector.ts's own DB_STALE_AFTER_MS/
 * SLOW_STREAM_STALE_AFTER_MS/SETTLED_FUNDING_STALE_AFTER_MS constants, passed
 * in rather than imported so this stays decoupled from collector.ts the same
 * way notify/healthcheck.ts's own FreshnessCheck.latestAt is decoupled from
 * any particular table shape. funding_rates(settled) needs its own,
 * separately-tuned threshold rather than reusing slowStreamStaleAfterMs — see
 * SETTLED_FUNDING_STALE_AFTER_MS's own comment for why it isn't like
 * long_short_ratio despite sharing the same 5-minute poll cadence.
 */
export function buildFreshnessChecks(
  dbStaleAfterMs: number,
  slowStreamStaleAfterMs: number,
  settledFundingStaleAfterMs: number,
): FreshnessCheck[] {
  return [
    {
      label: "tickers",
      staleAfterMs: dbStaleAfterMs,
      latestAt: async (checkDb: Kysely<Database>) => {
        const row = await checkDb.selectFrom("tickers").select(({ fn }) => fn.max("fetched_at").as("latest")).executeTakeFirst();
        return row?.latest ?? null;
      },
    },
    {
      label: "orderbook_levels",
      staleAfterMs: dbStaleAfterMs,
      latestAt: async (checkDb: Kysely<Database>) => {
        const row = await checkDb.selectFrom("orderbook_levels").select(({ fn }) => fn.max("fetched_at").as("latest")).executeTakeFirst();
        return row?.latest ?? null;
      },
    },
    {
      label: "long_short_ratio",
      staleAfterMs: slowStreamStaleAfterMs,
      latestAt: async (checkDb: Kysely<Database>) => {
        const row = await checkDb.selectFrom("long_short_ratio").select(({ fn }) => fn.max("fetched_at").as("latest")).executeTakeFirst();
        return row?.latest ?? null;
      },
    },
    {
      label: "funding_rates(settled)",
      staleAfterMs: settledFundingStaleAfterMs,
      latestAt: async (checkDb: Kysely<Database>) => {
        const row = await checkDb
          .selectFrom("funding_rates")
          .select(({ fn }) => fn.max("fetched_at").as("latest"))
          .where("kind", "=", "settled")
          .executeTakeFirst();
        return row?.latest ?? null;
      },
    },
  ];
}
