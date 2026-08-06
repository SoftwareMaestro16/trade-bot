import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { PublicExchangeClient } from "../../src/exchange/client.js";
import { RateLimiter } from "../../src/exchange/rateLimiter.js";
import { collectSettledFunding } from "../../src/market-data/collectSettledFunding.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const SYM = "__TEST_SETTLED__USDT";

function okResponse(result: unknown) {
  return { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: Date.now() };
}

afterEach(() => nock.cleanAll());

describe("collectSettledFunding", () => {
  let db: Kysely<Database>;
  const universe = [{ symbol: SYM, fundingIntervalMinutes: 480 }];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });
  afterEach(async () => {
    await db.deleteFrom("funding_rates").where("symbol", "=", SYM).execute();
  });
  afterAll(async () => db.destroy());

  it("writes all returned settlements when nothing is known yet", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/funding/history")
      .query(true)
      .reply(
        200,
        okResponse({
          list: [
            { symbol: SYM, fundingRate: "0.0001", fundingRateTimestamp: "1785944000000" },
            { symbol: SYM, fundingRate: "0.0002", fundingRateTimestamp: "1785958400000" },
          ],
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectSettledFunding(client, db, universe, new RateLimiter(0));

    expect(result).toEqual({ written: 2, failed: [] });

    const rows = await db.selectFrom("funding_rates").selectAll().where("symbol", "=", SYM).execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "settled")).toBe(true);
    expect(rows.every((r) => r.interval_minutes === 480)).toBe(true);
  });

  it("does not re-insert a settlement it has already recorded (dedup by max known funding_timestamp_ms)", async () => {
    await db
      .insertInto("funding_rates")
      .values({
        symbol: SYM,
        kind: "settled",
        rate: "0.0002",
        interval_minutes: 480,
        funding_timestamp_ms: "1785958400000",
      })
      .execute();

    nock(TESTNET_BASE)
      .get("/v5/market/funding/history")
      .query(true)
      .reply(
        200,
        okResponse({
          list: [
            // Already known -> must be skipped.
            { symbol: SYM, fundingRate: "0.0002", fundingRateTimestamp: "1785958400000" },
            // Older than known max -> must be skipped too.
            { symbol: SYM, fundingRate: "0.0001", fundingRateTimestamp: "1785944000000" },
            // Genuinely new -> must be written.
            { symbol: SYM, fundingRate: "0.0003", fundingRateTimestamp: "1785972800000" },
          ],
        }),
      );

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectSettledFunding(client, db, universe, new RateLimiter(0));

    expect(result).toEqual({ written: 1, failed: [] });

    const rows = await db.selectFrom("funding_rates").selectAll().where("symbol", "=", SYM).execute();
    // The pre-seeded row + exactly one new row.
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.funding_timestamp_ms === "1785972800000" && r.rate === "0.0003")).toBe(true);
  });

  it("first poll for a symbol (no known baseline) requests limit=5 with no startTime", async () => {
    const scope = nock(TESTNET_BASE)
      .get("/v5/market/funding/history")
      .query((q) => q.limit === "5" && q.startTime === undefined && q.symbol === SYM)
      .reply(200, okResponse({ list: [] }));

    const client = new PublicExchangeClient({ testnet: true });
    await collectSettledFunding(client, db, universe, new RateLimiter(0));

    expect(scope.isDone()).toBe(true);
  });

  it("catch-up poll (a known baseline exists) requests startTime=knownMax+1, endTime, and limit=200, not the plain limit=5 that can only ever see the 5 most recent settlements and would silently orphan anything older after a longer gap", async () => {
    await db
      .insertInto("funding_rates")
      .values({
        symbol: SYM,
        kind: "settled",
        rate: "0.0002",
        interval_minutes: 480,
        funding_timestamp_ms: "1785958400000",
      })
      .execute();

    // endTime is asserted PRESENT (not a specific value — it's "now", which
    // this test doesn't control) as well as startTime/limit: Bybit's real
    // /v5/market/funding/history REJECTS startTime without endTime
    // (retCode 10001 "params error: Time Is Invalid", confirmed against the
    // live endpoint) — a request missing it would have silently broken every
    // catch-up poll, which is exactly what happened in production for ~2.4
    // hours before this was caught. See the next test for that failure mode
    // reproduced directly.
    const scope = nock(TESTNET_BASE)
      .get("/v5/market/funding/history")
      .query(
        (q) =>
          q.limit === "200" && q.startTime === "1785958400001" && q.endTime !== undefined && q.symbol === SYM,
      )
      .reply(200, okResponse({ list: [] }));

    const client = new PublicExchangeClient({ testnet: true });
    await collectSettledFunding(client, db, universe, new RateLimiter(0));

    expect(scope.isDone()).toBe(true);
  });

  it("a request Bybit rejects for missing endTime (retCode 10001) is caught, logged once with the real error, and the symbol is marked failed — not silently swallowed", async () => {
    await db
      .insertInto("funding_rates")
      .values({
        symbol: SYM,
        kind: "settled",
        rate: "0.0002",
        interval_minutes: 480,
        funding_timestamp_ms: "1785958400000",
      })
      .execute();

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulates Bybit's real, confirmed response shape for a startTime-without-
    // endTime request. bybit-api's client (throwExceptions:true, RR-51) turns
    // a non-zero retCode into a thrown error, which this test's own
    // collectSettledFunding call must catch, not propagate.
    nock(TESTNET_BASE)
      .get("/v5/market/funding/history")
      .query(true)
      .reply(200, { retCode: 10001, retMsg: "params error: Time Is Invalid", result: { category: "", list: [] }, retExtInfo: {}, time: Date.now() });

    const client = new PublicExchangeClient({ testnet: true });
    const result = await collectSettledFunding(client, db, universe, new RateLimiter(0));

    expect(result.failed).toEqual([SYM]);
    expect(result.written).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("first failure this cycle"),
      expect.anything(),
    );

    consoleErrorSpy.mockRestore();
  });
});
