import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { runCollectionCycle } from "../../src/market-data/collectionRun.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

/**
 * `collection_runs` has no per-test scoping column (unlike the fake-symbol
 * pattern the other market-data tests use) — it's inherently a shared,
 * global table. Querying "all rows, expect exactly N" is racy against any
 * other test file writing to the same table concurrently (vitest runs test
 * FILES in parallel by default), which is exactly what broke this file once
 * already (test/market-data/collectionDigest.test.ts's fixtures leaked in).
 * Scoping every read to `id > <max id before this test's own action>` makes
 * each assertion correct regardless of what else is happening in the table.
 */
async function maxId(db: Kysely<Database>): Promise<bigint> {
  const row = await db
    .selectFrom("collection_runs")
    .select(({ fn }) => fn.max("id").as("max_id"))
    .executeTakeFirst();
  return row?.max_id ?? 0n;
}

describe("runCollectionCycle", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });
  afterAll(async () => db.destroy());

  it("records a successful cycle as completed with the right symbol count (FR-109)", async () => {
    const before = await maxId(db);
    const result = await runCollectionCycle(db, 3, async () => ({ symbolsCollected: 3, extra: "payload" }));
    expect(result).toEqual({ symbolsCollected: 3, extra: "payload" });

    const rows = await db.selectFrom("collection_runs").selectAll().where("id", ">", before).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.symbols_expected).toBe(3);
    expect(rows[0]?.symbols_collected).toBe(3);
    expect(rows[0]?.finished_at).not.toBeNull();

    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });

  it("records a failed cycle with the error message, and still rethrows to the caller (RR-50: no swallowed exceptions)", async () => {
    const before = await maxId(db);
    await expect(
      runCollectionCycle(db, 5, async () => {
        throw new Error("bybit is down");
      }),
    ).rejects.toThrow("bybit is down");

    const rows = await db.selectFrom("collection_runs").selectAll().where("id", ">", before).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toBe("bybit is down");
    expect(rows[0]?.symbols_collected).toBeNull();

    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });

  it("defaults new rows to status='running' before fn resolves (verifiable via a slow fn)", async () => {
    const before = await maxId(db);
    let sawRunning = false;
    await runCollectionCycle(db, 1, async () => {
      const row = await db
        .selectFrom("collection_runs")
        .selectAll()
        .where("id", ">", before)
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirstOrThrow();
      sawRunning = row.status === "running";
      return { symbolsCollected: 1 };
    });
    expect(sawRunning).toBe(true);

    await db.deleteFrom("collection_runs").where("id", ">", before).execute();
  });
});
