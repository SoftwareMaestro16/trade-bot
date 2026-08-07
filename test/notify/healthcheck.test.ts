import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { startHeartbeat } from "../../src/notify/healthcheck.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const BASE = "https://hc-ping.com";
const PING_PATH = "/00000000-0000-0000-0000-000000000000";
const STALE_AFTER_MS = 60_000;

// A pool pointed at a port nothing listens on: any real query against it
// rejects (connection refused) — same pattern as
// killswitch/authorizedUsers.test.ts's brokenDb(), used below to exercise
// isDataFresh's catch branch (a genuine query failure — "DB down, connection
// dropped" per its doc comment) without waiting out a real network timeout
// against an unreachable host.
function brokenDb(): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: "postgresql://nouser:nopass@127.0.0.1:1/nonexistent" });
  pool.on("error", () => {
    // Same reasoning as storage/db.ts's pool 'error' handler: zero listeners
    // on a background pool error is an uncaught exception in Node. This pool
    // is deliberately never going to connect successfully, so a listener
    // that does nothing is the correct (and only sane) response here.
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

// Real timers throughout — same reasoning as telegramPolling.test.ts: fake
// timers' "Async" helpers only bound-await the timer callback they fire, not
// a mocked fetch/undici round-trip that callback goes on to trigger.
afterEach(() => nock.cleanAll());

describe("startHeartbeat (against a real local Postgres, mocked ping endpoint)", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });
  afterEach(async () => {
    await db.deleteFrom("tickers").where("symbol", "=", "HEARTBEATTEST").execute();
  });
  afterAll(async () => db.destroy());

  async function insertTicker(fetchedAt: Date): Promise<void> {
    await db
      .insertInto("tickers")
      .values({ symbol: "HEARTBEATTEST", category: "linear", last_price: "1.0", fetched_at: fetchedAt })
      .execute();
  }

  it("pings immediately on start when tickers data is fresh, then again after each interval", async () => {
    await insertTicker(new Date());
    let hits = 0;
    nock(BASE).get(PING_PATH).query(true).times(3).reply(() => {
      hits++;
      return [200, "OK"];
    });

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 50, db, STALE_AFTER_MS);

    await vi.waitFor(() => expect(hits).toBeGreaterThanOrEqual(3));
    await handle.stop();
  });

  it("withholds the ping (and logs) when the newest tickers row is older than staleAfterMs", async () => {
    await insertTicker(new Date(Date.now() - STALE_AFTER_MS - 60_000));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No nock interceptor registered — if the heartbeat tried to ping anyway,
    // this would fail with a real "no match" error from nock, not silently pass.

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 30, db, STALE_AFTER_MS);

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("stale beyond"));
    });

    await handle.stop();
    consoleErrorSpy.mockRestore();
  });

  it("withholds the ping when tickers has no rows at all", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 30, db, STALE_AFTER_MS);

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("stale beyond"));
    });

    await handle.stop();
    consoleErrorSpy.mockRestore();
  });

  it("withholds the ping (fails closed) when the freshness query itself fails — not merely 'no fresh rows'", async () => {
    // Insert a fresh row via the REAL db first, to prove this test is
    // exercising the query-failure catch branch specifically, not merely
    // falling through the already-covered "no fresh row"/"stale row" paths:
    // the broken connection below can't even reach `tickers` to find out
    // whether this row exists.
    await insertTicker(new Date());
    const broken = brokenDb();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No nock interceptor registered — if isDataFresh failed OPEN instead of
    // closed, the heartbeat would attempt a real ping and nock would reject
    // it with a "no match registered" error, which would surface as an
    // unexpected "[heartbeat] ping failed:" log instead of the assertions
    // below ever matching — so a regression here fails loudly, not silently.

    try {
      const handle = startHeartbeat(`${BASE}${PING_PATH}`, 30, broken, STALE_AFTER_MS);

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith("[heartbeat] DB freshness check failed:", expect.any(String));
      });
      // isDataFresh's catch returns false same as genuine staleness, so the
      // caller (tick()) withholds the ping the same way it would for stale data.
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("stale beyond"));

      await handle.stop();
    } finally {
      consoleErrorSpy.mockRestore();
      await broken.destroy();
    }
  });

  it("a failed ping (network error) is logged and does not stop future pings or throw", async () => {
    await insertTicker(new Date());
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    nock(BASE).get(PING_PATH).query(true).replyWithError(new Error("connection reset"));
    nock(BASE).get(PING_PATH).query(true).reply(200, "OK");

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 30, db, STALE_AFTER_MS);

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith("[heartbeat] ping failed:", expect.any(String));
    });

    await handle.stop();
    consoleErrorSpy.mockRestore();
  });

  it("a non-2xx response is logged but does not throw or stop the loop", async () => {
    await insertTicker(new Date());
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    nock(BASE).get(PING_PATH).query(true).reply(500);
    nock(BASE).get(PING_PATH).query(true).reply(200, "OK");

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 30, db, STALE_AFTER_MS);

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
    });

    await handle.stop();
    consoleErrorSpy.mockRestore();
  });

  it("stop() prevents any further ping, even one already scheduled", async () => {
    await insertTicker(new Date());
    // .persist() deliberately: a non-persistent single-use interceptor would
    // let a second ping (fired if this test's own polling loses the race
    // against the 30ms interval) fail to match and get logged as a spurious
    // "ping failed" error — harmless to the assertion below either way, but
    // noisy and beside this test's actual point.
    let hits = 0;
    nock(BASE)
      .get(PING_PATH)
      .query(true)
      .reply(() => {
        hits++;
        return [200, "OK"];
      })
      .persist();

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 30, db, STALE_AFTER_MS);
    await vi.waitFor(() => expect(hits).toBeGreaterThanOrEqual(1));

    await handle.stop();
    const afterStop = hits;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hits).toBe(afterStop); // no further pings after stop(), despite waiting well past the interval
  });

  it("stop() waits for an in-flight ping to finish before resolving", async () => {
    await insertTicker(new Date());
    let resolvePing!: () => void;
    const pingGate = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    let requestStarted = false;
    nock(BASE)
      .get(PING_PATH)
      .query(true)
      .reply(async () => {
        requestStarted = true; // set BEFORE awaiting the gate, so the test can detect "the fetch is genuinely in flight"
        await pingGate;
        return [200, "OK"];
      });

    const handle = startHeartbeat(`${BASE}${PING_PATH}`, 10_000, db, STALE_AFTER_MS); // interval doesn't matter — only the first, in-flight ping is exercised here

    // The heartbeat's own first tick fires on a 0ms setTimeout, which still
    // yields at least one event-loop turn — calling stop() before the first
    // ping has actually started would (correctly) resolve it immediately,
    // since there'd be nothing in flight yet. Wait for the request to
    // genuinely be in progress before exercising the "waits for it" behavior.
    await vi.waitFor(() => expect(requestStarted).toBe(true));

    let stopResolved = false;
    const stopPromise = handle.stop().then(() => {
      stopResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopResolved).toBe(false); // the in-flight ping is still hanging on pingGate

    resolvePing();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });
});
