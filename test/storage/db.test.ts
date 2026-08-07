import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import pg from "pg";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

const TEST_SYMBOL = "__TEST_PRECISION__";

describe("storage/db numeric precision (ADR-003/NFR-02, against a real local Postgres)", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run `docker compose up -d` and ensure .env has DATABASE_URL before running this test.",
      );
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    await db.deleteFrom("tickers").where("symbol", "=", TEST_SYMBOL).execute();
    await db.deleteFrom("funding_rates").where("symbol", "=", TEST_SYMBOL).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("round-trips a numeric value with more significant digits than float64 can hold exactly, as a string", async () => {
    // float64 has ~15-17 significant decimal digits; this has 20. If the driver (or a
    // stray type parser) ever coerced `numeric` to JS `number`, this value would be
    // silently rounded on the way back out — the exact failure mode ADR-003 exists to prevent.
    const exactValue = "64725.123456789012345678";

    await db
      .insertInto("tickers")
      .values({
        symbol: TEST_SYMBOL,
        category: "linear",
        last_price: exactValue,
      })
      .execute();

    const row = await db
      .selectFrom("tickers")
      .select(["last_price"])
      .where("symbol", "=", TEST_SYMBOL)
      .executeTakeFirstOrThrow();

    expect(typeof row.last_price).toBe("string");
    expect(row.last_price).toBe(exactValue);
  });

  it("round-trips a bigint beyond Number.MAX_SAFE_INTEGER as a string, not a lossy number", async () => {
    // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991. A funding timestamp in ms won't
    // reach this for centuries, but the driver must not coerce int8 to `number` regardless —
    // that coercion, if it existed, would silently corrupt any bigint column, not just this one.
    const bigValue = "9007199254740993"; // MAX_SAFE_INTEGER + 2, not representable exactly as a JS number

    await db
      .insertInto("funding_rates")
      .values({
        symbol: TEST_SYMBOL,
        kind: "settled",
        rate: "0.0001",
        interval_minutes: 480,
        funding_timestamp_ms: bigValue,
      })
      .execute();

    const row = await db
      .selectFrom("funding_rates")
      .select(["funding_timestamp_ms"])
      .where("symbol", "=", TEST_SYMBOL)
      .executeTakeFirstOrThrow();

    expect(typeof row.funding_timestamp_ms).toBe("string");
    expect(row.funding_timestamp_ms).toBe(bigValue);
  });

  it("rejects a row with a check-constraint violation (interval_minutes <= 0) instead of silently accepting it", async () => {
    await expect(
      db
        .insertInto("funding_rates")
        .values({
          symbol: TEST_SYMBOL,
          kind: "settled",
          rate: "0.0001",
          interval_minutes: 0,
          funding_timestamp_ms: "1000",
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe("storage/db createDb() background pool error handling (against a real local Postgres)", () => {
  // Regression test for the incident documented directly above pool.on("error", ...)
  // in src/storage/db.ts: a background failure on an IDLE pooled client (DB restart,
  // network partition) is a completely different event than a query-level failure —
  // it fires on the pg.Pool itself, not on any in-flight query's promise. With zero
  // listeners attached, Node's default EventEmitter behavior turns that into an
  // uncaught exception and kills the whole process. This previously happened to a
  // long-running collector/killswitch-listener process. None of the tests above
  // exercise this path — they only ever see a *healthy* pool, or (elsewhere, in
  // authorizedUsers.test.ts) a pool whose connection attempt itself fails, which
  // rejects the query's own promise instead of going through pool.on("error", ...).
  //
  // To trigger the exact "idle client dies in the background" scenario for real
  // (not simulated), we: (1) run one query through createDb()'s own pool so a real
  // client connects and is then released back into the pool as idle, (2) from a
  // genuinely separate connection, force-terminate that backend server-side with
  // pg_terminate_backend — this is what a DB restart / network partition looks like
  // from the idle client's point of view, since there's no in-flight query to reject.
  it(
    "does not crash the process when the pool's idle client dies in the background — logs via console.error instead of throwing uncaught",
    async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          "DATABASE_URL is not set — run `docker compose up -d` and ensure .env has DATABASE_URL before running this test.",
        );
      }

      const backgroundDb = createDb(process.env.DATABASE_URL);
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Belt-and-braces proof that "the event was actually caught somewhere" rather
      // than merely absent because nothing happened: if createDb()'s pool.on("error", ...)
      // listener were ever accidentally dropped or broken by a future refactor, the
      // resulting uncaught exception would surface here instead of crashing the
      // whole test worker silently.
      const uncaughtExceptions: unknown[] = [];
      const unhandledRejections: unknown[] = [];
      const onUncaughtException = (err: unknown) => uncaughtExceptions.push(err);
      const onUnhandledRejection = (err: unknown) => unhandledRejections.push(err);
      process.on("uncaughtException", onUncaughtException);
      process.on("unhandledRejection", onUnhandledRejection);

      let killerPool: pg.Pool | undefined;
      try {
        // Acquire a connection through createDb()'s own pool and let it go idle:
        // Kysely releases the client back to the pool as soon as this query's
        // promise resolves (see kysely's DefaultConnectionProvider.provideConnection),
        // which happens before this `await` returns.
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(backgroundDb);
        const pidRow = rows[0];
        if (pidRow === undefined) {
          throw new Error("pg_backend_pid() query returned no rows");
        }
        const victimPid = pidRow.pid;

        // A genuinely separate connection — not backgroundDb's pool — used only to
        // kill the now-idle backend above. Same DB role, so it's allowed to signal
        // its own role's other sessions without needing superuser privileges.
        killerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        killerPool.on("error", () => {
          // This pool is never meant to go idle-and-die itself; a no-op listener is
          // only here so an unrelated background error on IT doesn't crash this test.
        });
        await killerPool.query("select pg_terminate_backend($1)", [victimPid]);

        // The idle client's background failure should surface as exactly the
        // console.error call from createDb()'s pool.on("error", ...) handler —
        // never as an uncaught exception that would kill the process.
        await vi.waitFor(
          () => {
            expect(consoleErrorSpy).toHaveBeenCalledWith(
              "[db] background pool error on an idle connection:",
              expect.any(Error),
            );
          },
          { timeout: 8000, interval: 50 },
        );

        expect(uncaughtExceptions).toEqual([]);
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaughtException);
        process.off("unhandledRejection", onUnhandledRejection);
        consoleErrorSpy.mockRestore();
        if (killerPool) {
          await killerPool.end();
        }
        await backgroundDb.destroy();
      }
    },
    15000,
  );
});
