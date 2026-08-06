import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { extractFundingEpisodes } from "../../src/predictive/episodeExtraction.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

/**
 * Real local/test Postgres required — same convention as
 * test/emulation/scenarioRunner.test.ts and test/storage/db.test.ts. No skip
 * on a missing DATABASE_URL: a silently-skipped test that never ran is worse
 * than a loud failure.
 */

const SYMBOL_TRUE = "__TEST_PRED_LABELTRUE__USDT";
const SYMBOL_FALSE = "__TEST_PRED_LABELFALSE__USDT";
const SYMBOL_CENSORED = "__TEST_PRED_CENSORED__USDT";
const SYMBOL_OTHER = "__TEST_PRED_OTHER__USDT";
const ALL_TEST_SYMBOLS = [SYMBOL_TRUE, SYMBOL_FALSE, SYMBOL_CENSORED, SYMBOL_OTHER];

const INTERVAL_MINUTES = 480; // 8h — r8h = rate directly, keeps fixture rates easy to reason about
const HOUR_MS = 60 * 60 * 1000;
const LABEL_WINDOW_HOURS = 72; // DEFAULT_LABEL_WINDOW_HOURS

// ENTRY_FLOOR_R8H is 0.0002 (risk/economics.ts / predictive/episodeExtraction.ts's own mirrored copy).
const HIGH_RATE = "0.001"; // comfortably above the floor
const LOW_RATE = "0.0001"; // comfortably below the floor

async function insertPredicted(db: Kysely<Database>, symbol: string, fetchedAt: Date, rate: string): Promise<void> {
  await db
    .insertInto("funding_rates")
    .values({
      symbol,
      kind: "predicted",
      rate,
      interval_minutes: INTERVAL_MINUTES,
      funding_timestamp_ms: String(fetchedAt.getTime() + 8 * HOUR_MS),
      fetched_at: fetchedAt,
    })
    .execute();
}

async function insertSettled(
  db: Kysely<Database>,
  symbol: string,
  fundingTimestampMs: number,
  rate: string,
): Promise<void> {
  await db
    .insertInto("funding_rates")
    .values({
      symbol,
      kind: "settled",
      rate,
      interval_minutes: INTERVAL_MINUTES,
      funding_timestamp_ms: String(fundingTimestampMs),
      fetched_at: new Date(fundingTimestampMs),
    })
    .execute();
}

describe("extractFundingEpisodes (predictive/episodeExtraction.ts, against a real local Postgres)", () => {
  let db: Kysely<Database>;
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const windowEndMs = t0.getTime() + LABEL_WINDOW_HOURS * HOUR_MS;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run `docker compose up -d` and ensure .env has DATABASE_URL before running this test.",
      );
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    await db.deleteFrom("funding_rates").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("labels an episode true when every settled reading through episodeStartMs + N hours stays at/above the entry floor", async () => {
    await insertPredicted(db, SYMBOL_TRUE, t0, HIGH_RATE);
    await insertSettled(db, SYMBOL_TRUE, t0.getTime() + 36 * HOUR_MS, HIGH_RATE);
    await insertSettled(db, SYMBOL_TRUE, windowEndMs, HIGH_RATE); // reaches the window boundary exactly (inclusive)

    const episodes = await extractFundingEpisodes(db, SYMBOL_TRUE);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.symbol).toBe(SYMBOL_TRUE);
    expect(episodes[0]!.episodeStartMs).toBe(t0.getTime());
    expect(episodes[0]!.label).toBe(true);
    expect(episodes[0]!.labelWindowHours).toBe(LABEL_WINDOW_HOURS);
    expect(episodes[0]!.features.r8hAtStart.toString()).toBe(HIGH_RATE);
  });

  it("labels an episode false when a single settled reading inside the window drops below the entry floor", async () => {
    await insertPredicted(db, SYMBOL_FALSE, t0, HIGH_RATE);
    await insertSettled(db, SYMBOL_FALSE, t0.getTime() + 36 * HOUR_MS, HIGH_RATE);
    await insertSettled(db, SYMBOL_FALSE, windowEndMs, LOW_RATE); // one bad reading is enough to flip the label

    const episodes = await extractFundingEpisodes(db, SYMBOL_FALSE);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.label).toBe(false);
  });

  it("excludes (does not label true or false) an episode whose settled history doesn't reach episodeStartMs + N hours yet", async () => {
    await insertPredicted(db, SYMBOL_CENSORED, t0, HIGH_RATE);
    // Settled coverage stops well short of the 72h window boundary — right-censored.
    await insertSettled(db, SYMBOL_CENSORED, t0.getTime() + 10 * HOUR_MS, HIGH_RATE);

    const episodes = await extractFundingEpisodes(db, SYMBOL_CENSORED);

    expect(episodes).toHaveLength(0);
  });

  it("never mixes another symbol's settled data into this symbol's label or feature set", async () => {
    await insertPredicted(db, SYMBOL_TRUE, t0, HIGH_RATE);
    await insertSettled(db, SYMBOL_TRUE, t0.getTime() + 36 * HOUR_MS, HIGH_RATE);
    await insertSettled(db, SYMBOL_TRUE, windowEndMs, HIGH_RATE);

    // SYMBOL_OTHER has data at the exact same timestamps but rates that would
    // flip SYMBOL_TRUE's label if it ever leaked across the symbol filter.
    await insertPredicted(db, SYMBOL_OTHER, t0, HIGH_RATE);
    await insertSettled(db, SYMBOL_OTHER, t0.getTime() + 36 * HOUR_MS, LOW_RATE);
    await insertSettled(db, SYMBOL_OTHER, windowEndMs, LOW_RATE);

    const episodesTrue = await extractFundingEpisodes(db, SYMBOL_TRUE);
    expect(episodesTrue).toHaveLength(1);
    expect(episodesTrue[0]!.symbol).toBe(SYMBOL_TRUE);
    expect(episodesTrue[0]!.label).toBe(true); // must not have been dragged false by SYMBOL_OTHER's rows

    const episodesOther = await extractFundingEpisodes(db, SYMBOL_OTHER);
    expect(episodesOther).toHaveLength(1);
    expect(episodesOther[0]!.symbol).toBe(SYMBOL_OTHER);
    expect(episodesOther[0]!.label).toBe(false);
  });

  it("returns no episodes for a symbol with no predicted funding history at all", async () => {
    const episodes = await extractFundingEpisodes(db, "__TEST_PRED_NEVER_SEEN__USDT");
    expect(episodes).toHaveLength(0);
  });
});
