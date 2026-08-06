import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
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
