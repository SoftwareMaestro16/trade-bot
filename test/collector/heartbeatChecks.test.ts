import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { buildFreshnessChecks } from "../../src/collector/heartbeatChecks.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const DB_STALE_AFTER_MS = 111;
const SLOW_STREAM_STALE_AFTER_MS = 222;
const SYM = "__TEST_COLLECTOR_HEARTBEAT__USDT";

/**
 * Extracted verbatim out of collector.ts main()'s `if (env.HEALTHCHECK_PING_URL)`
 * block (see src/collector/heartbeatChecks.ts's own doc comment). These tests
 * pin down the two things that block used to get right inline: which
 * staleAfterMs each check gets, and that each check's `latestAt` queries the
 * table/filter it claims to (in particular the settled-only `kind` filter on
 * `funding_rates`, and that `funding_rates(kind='predicted')` rows must NOT
 * count toward the "tickers" check even though collectTickers.ts's cycle also
 * writes to funding_rates).
 */
describe("buildFreshnessChecks", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });
  afterAll(async () => db.destroy());

  it("returns exactly the four labels collector.ts wired up, with the right staleAfterMs each", () => {
    const checks = buildFreshnessChecks(DB_STALE_AFTER_MS, SLOW_STREAM_STALE_AFTER_MS);

    expect(checks.map((c) => c.label)).toEqual([
      "tickers",
      "orderbook_levels",
      "long_short_ratio",
      "funding_rates(settled)",
    ]);
    expect(checks.find((c) => c.label === "tickers")?.staleAfterMs).toBe(DB_STALE_AFTER_MS);
    expect(checks.find((c) => c.label === "orderbook_levels")?.staleAfterMs).toBe(DB_STALE_AFTER_MS);
    expect(checks.find((c) => c.label === "long_short_ratio")?.staleAfterMs).toBe(SLOW_STREAM_STALE_AFTER_MS);
    expect(checks.find((c) => c.label === "funding_rates(settled)")?.staleAfterMs).toBe(SLOW_STREAM_STALE_AFTER_MS);
  });

  it("each check's latestAt resolves null when its own table/filter has no rows for it", async () => {
    const checks = buildFreshnessChecks(DB_STALE_AFTER_MS, SLOW_STREAM_STALE_AFTER_MS);
    for (const check of checks) {
      await expect(check.latestAt(db)).resolves.toBeNull();
    }
  });

  it("the 'funding_rates(settled)' check ignores 'predicted' rows for the same symbol (kind filter)", async () => {
    await db
      .insertInto("funding_rates")
      .values({
        symbol: SYM,
        kind: "predicted",
        rate: "0.0001",
        interval_minutes: 480,
        funding_timestamp_ms: String(Date.now()),
      })
      .execute();

    const checks = buildFreshnessChecks(DB_STALE_AFTER_MS, SLOW_STREAM_STALE_AFTER_MS);
    const settledCheck = checks.find((c) => c.label === "funding_rates(settled)");
    if (!settledCheck) throw new Error("expected a funding_rates(settled) check");

    await expect(settledCheck.latestAt(db)).resolves.toBeNull();

    await db.deleteFrom("funding_rates").where("symbol", "=", SYM).execute();
  });

  it("the 'tickers' check's latestAt reflects a freshly inserted tickers row", async () => {
    const fetchedAt = new Date();
    await db
      .insertInto("tickers")
      .values({ symbol: SYM, category: "linear", last_price: "1.0", fetched_at: fetchedAt })
      .execute();

    const checks = buildFreshnessChecks(DB_STALE_AFTER_MS, SLOW_STREAM_STALE_AFTER_MS);
    const tickersCheck = checks.find((c) => c.label === "tickers");
    if (!tickersCheck) throw new Error("expected a tickers check");

    const latest = await tickersCheck.latestAt(db);
    expect(latest).not.toBeNull();
    expect(latest?.getTime()).toBe(fetchedAt.getTime());

    await db.deleteFrom("tickers").where("symbol", "=", SYM).execute();
  });
});
