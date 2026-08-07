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
const SYMBOL_GAPPED = "__TEST_PRED_GAPPED__USDT";
const SYMBOL_PARTIAL_GAP = "__TEST_PRED_PARTIAL_GAP__USDT";
const SYMBOL_OTHER = "__TEST_PRED_OTHER__USDT";
const SYMBOL_CONTIGUOUS_RUN = "__TEST_PRED_CONTIGUOUS_RUN__USDT";
const SYMBOL_MULTI_EPISODE = "__TEST_PRED_MULTI_EPISODE__USDT";
const SYMBOL_FEATURES = "__TEST_PRED_FEATURES__USDT";
const ALL_TEST_SYMBOLS = [
  SYMBOL_TRUE,
  SYMBOL_FALSE,
  SYMBOL_CENSORED,
  SYMBOL_GAPPED,
  SYMBOL_PARTIAL_GAP,
  SYMBOL_OTHER,
  SYMBOL_CONTIGUOUS_RUN,
  SYMBOL_MULTI_EPISODE,
  SYMBOL_FEATURES,
];

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

/**
 * Fills every settlement slot of a symbol's 72h/`INTERVAL_MINUTES`-spaced
 * label window (`episodeStartMs + INTERVAL_MINUTES`, `+2*INTERVAL_MINUTES`,
 * ..., `+ LABEL_WINDOW_HOURS`) with `rateForSlot(slotMs)`'s result, or skips
 * that slot entirely when it returns `undefined`. `computeSurvivalLabel`
 * (episodeExtraction.ts) now requires gap-free coverage across the whole
 * window, not just any two rows inside it, to treat the window as knowable
 * — this is the fixture helper for that, and the `undefined`-skip lets a
 * test punch a single mid-window hole (see the "partial gap" test below).
 */
async function insertFullSettledCoverage(
  db: Kysely<Database>,
  symbol: string,
  episodeStartMs: number,
  rateForSlot: (slotMs: number) => string | undefined,
): Promise<void> {
  const stepMs = INTERVAL_MINUTES * 60 * 1000;
  const windowEndMs = episodeStartMs + LABEL_WINDOW_HOURS * HOUR_MS;
  for (let slotMs = episodeStartMs + stepMs; slotMs <= windowEndMs; slotMs += stepMs) {
    const rate = rateForSlot(slotMs);
    if (rate !== undefined) await insertSettled(db, symbol, slotMs, rate);
  }
}

// Below: insert helpers for the three tables `fetchOpenInterestWindow` /
// `fetchLongShortRatioAtStart` / `fetchLiquidationWindow` read, plus
// `fetchFundingVolatilityHistory`'s own `funding_rates` read is already
// covered by `insertSettled` above. `data_period`/`data_timestamp_ms`/
// `liquidation_time_ms` are NOT NULL columns these feature builders never
// select, so fixture values are arbitrary but present.

async function insertOpenInterest(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  openInterest: string,
): Promise<void> {
  await db
    .insertInto("open_interest")
    .values({
      symbol,
      open_interest: openInterest,
      data_period: "5min",
      data_timestamp_ms: String(fetchedAt.getTime()),
      fetched_at: fetchedAt,
    })
    .execute();
}

async function insertLongShortRatio(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  buyRatio: string,
  sellRatio: string,
): Promise<void> {
  await db
    .insertInto("long_short_ratio")
    .values({
      symbol,
      buy_ratio: buyRatio,
      sell_ratio: sellRatio,
      data_period: "5min",
      data_timestamp_ms: String(fetchedAt.getTime()),
      fetched_at: fetchedAt,
    })
    .execute();
}

async function insertLiquidation(
  db: Kysely<Database>,
  symbol: string,
  receivedAt: Date,
  side: "Buy" | "Sell",
  size: string,
  price: string,
): Promise<void> {
  await db
    .insertInto("liquidations")
    .values({
      symbol,
      side,
      size,
      price,
      liquidation_time_ms: String(receivedAt.getTime()),
      received_at: receivedAt,
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
    await db.deleteFrom("open_interest").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
    await db.deleteFrom("long_short_ratio").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
    await db.deleteFrom("liquidations").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("labels an episode true when every settled reading through episodeStartMs + N hours stays at/above the entry floor", async () => {
    await insertPredicted(db, SYMBOL_TRUE, t0, HIGH_RATE);
    // Full, gap-free coverage — every 8h slot through the window boundary (inclusive).
    await insertFullSettledCoverage(db, SYMBOL_TRUE, t0.getTime(), () => HIGH_RATE);

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
    // Full, gap-free coverage, except the last slot (window boundary) — one bad
    // reading is enough to flip the label, but coverage itself must stay complete.
    await insertFullSettledCoverage(db, SYMBOL_FALSE, t0.getTime(), (slotMs) =>
      slotMs === windowEndMs ? LOW_RATE : HIGH_RATE,
    );

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

  it("excludes (does not label true or false) an episode whose settled history reaches past the window boundary but has zero settled rows inside the window itself (module doc comment's 'Gapped' case, distinct from right-censoring)", async () => {
    await insertPredicted(db, SYMBOL_GAPPED, t0, HIGH_RATE);
    // Settled coverage reaches well past the 72h window boundary...
    await insertSettled(db, SYMBOL_GAPPED, windowEndMs + 10 * HOUR_MS, HIGH_RATE);
    // ...but zero settled rows fall inside (episodeStartMs, windowEndMs] itself — a
    // collector gap spanning exactly this episode's window, not right-censoring.

    const episodes = await extractFundingEpisodes(db, SYMBOL_GAPPED);

    expect(episodes).toHaveLength(0);
  });

  it("excludes (does not label true or false) an episode whose settled history has full outer coverage but a single MISSING settlement in the middle of the window (partial gap, distinct from the zero-row 'Gapped' case above and from right-censoring)", async () => {
    const missingSlotMs = t0.getTime() + 40 * HOUR_MS; // one of the 9 expected 8h-spaced slots
    await insertPredicted(db, SYMBOL_PARTIAL_GAP, t0, HIGH_RATE);
    // Every slot present and above the floor EXCEPT one middle one — if that
    // missing settlement had actually been recorded, it would have been below
    // the floor (this is exactly what makes the gap dangerous: the present
    // rows alone all look fine, which is why gap-detection must not rely on
    // "every present row passes").
    await insertFullSettledCoverage(db, SYMBOL_PARTIAL_GAP, t0.getTime(), (slotMs) =>
      slotMs === missingSlotMs ? undefined : HIGH_RATE,
    );

    const episodes = await extractFundingEpisodes(db, SYMBOL_PARTIAL_GAP);

    expect(episodes).toHaveLength(0);
  });

  it("never mixes another symbol's settled data into this symbol's label or feature set", async () => {
    await insertPredicted(db, SYMBOL_TRUE, t0, HIGH_RATE);
    await insertFullSettledCoverage(db, SYMBOL_TRUE, t0.getTime(), () => HIGH_RATE);

    // SYMBOL_OTHER has data at the exact same timestamps but rates that would
    // flip SYMBOL_TRUE's label if it ever leaked across the symbol filter.
    await insertPredicted(db, SYMBOL_OTHER, t0, HIGH_RATE);
    await insertFullSettledCoverage(db, SYMBOL_OTHER, t0.getTime(), () => LOW_RATE);

    const episodesTrue = await extractFundingEpisodes(db, SYMBOL_TRUE);
    expect(episodesTrue).toHaveLength(1);
    expect(episodesTrue[0]!.symbol).toBe(SYMBOL_TRUE);
    expect(episodesTrue[0]!.label).toBe(true); // must not have been dragged false by SYMBOL_OTHER's rows

    const episodesOther = await extractFundingEpisodes(db, SYMBOL_OTHER);
    expect(episodesOther).toHaveLength(1);
    expect(episodesOther[0]!.symbol).toBe(SYMBOL_OTHER);
    expect(episodesOther[0]!.label).toBe(false);
  });

  it("collapses a multi-row above-floor run into a single episode starting at the first row (no re-trigger on later rows of the same run)", async () => {
    // Three consecutive predicted rows, all above the floor — one contiguous
    // run, so findEpisodeStarts must only fire on the first row.
    await insertPredicted(db, SYMBOL_CONTIGUOUS_RUN, t0, HIGH_RATE);
    await insertPredicted(db, SYMBOL_CONTIGUOUS_RUN, new Date(t0.getTime() + 1 * HOUR_MS), HIGH_RATE);
    await insertPredicted(db, SYMBOL_CONTIGUOUS_RUN, new Date(t0.getTime() + 2 * HOUR_MS), HIGH_RATE);
    await insertFullSettledCoverage(db, SYMBOL_CONTIGUOUS_RUN, t0.getTime(), () => HIGH_RATE);

    const episodes = await extractFundingEpisodes(db, SYMBOL_CONTIGUOUS_RUN);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.episodeStartMs).toBe(t0.getTime());
  });

  it("emits a separate episode per contiguous above-floor run when funding dips below the floor and rises again (dip-and-rise)", async () => {
    const episode2StartMs = t0.getTime() + 3 * HOUR_MS;
    const episode2WindowEndMs = episode2StartMs + LABEL_WINDOW_HOURS * HOUR_MS;

    // Episode 1: rows at t0 and t0+1h, both above floor (one run).
    await insertPredicted(db, SYMBOL_MULTI_EPISODE, t0, HIGH_RATE);
    await insertPredicted(db, SYMBOL_MULTI_EPISODE, new Date(t0.getTime() + 1 * HOUR_MS), HIGH_RATE);
    // Dip below the floor at t0+2h — ends episode 1's run without starting a new one.
    await insertPredicted(db, SYMBOL_MULTI_EPISODE, new Date(t0.getTime() + 2 * HOUR_MS), LOW_RATE);
    // Rising edge again at t0+3h starts episode 2; t0+4h is a second row of the
    // same run and must not re-trigger a third episode.
    await insertPredicted(db, SYMBOL_MULTI_EPISODE, new Date(episode2StartMs), HIGH_RATE);
    await insertPredicted(db, SYMBOL_MULTI_EPISODE, new Date(t0.getTime() + 4 * HOUR_MS), HIGH_RATE);

    // Full, gap-free coverage anchored on episode 1's start (t0+8h..t0+72h, 9
    // slots) — since episode 2's window ((t0+3h, t0+75h]) starts only 3h later
    // than episode 1's and shares the same 8h-spaced settlements, this same set
    // covers episode 2's window contiguously too, EXCEPT its own tail: episode
    // 2's window reaches 3h past t0+72h, so one more settlement is needed at
    // its own boundary to clear both the inner gap check and the outer
    // right-censoring check for episode 2 specifically.
    await insertFullSettledCoverage(db, SYMBOL_MULTI_EPISODE, t0.getTime(), () => HIGH_RATE);
    await insertSettled(db, SYMBOL_MULTI_EPISODE, episode2WindowEndMs, HIGH_RATE);

    const episodes = await extractFundingEpisodes(db, SYMBOL_MULTI_EPISODE);

    expect(episodes).toHaveLength(2);
    expect(episodes.map((e) => e.episodeStartMs)).toEqual([t0.getTime(), episode2StartMs]);
    expect(episodes[0]!.label).toBe(true);
    expect(episodes[1]!.label).toBe(true);
  });

  it("populates openInterestTrend/longShortRatioAtStart/recentLiquidationVolume/fundingVolatility from actual open_interest/long_short_ratio/liquidations/funding_rates rows, respecting each builder's window bound and symbol filter", async () => {
    await insertPredicted(db, SYMBOL_FEATURES, t0, HIGH_RATE);
    await insertFullSettledCoverage(db, SYMBOL_FEATURES, t0.getTime(), () => HIGH_RATE);

    // --- open_interest: window is [t0 - 24h, t0] inclusive (openInterestTrendWindowHours=24). ---
    // Just outside the window — an extreme value that would corrupt earliest/changePercent if the
    // window's lower bound were off by one (or missing entirely).
    await insertOpenInterest(db, SYMBOL_FEATURES, new Date(t0.getTime() - 25 * HOUR_MS), "1");
    await insertOpenInterest(db, SYMBOL_FEATURES, new Date(t0.getTime() - 24 * HOUR_MS), "1000"); // exact lower boundary, inclusive
    await insertOpenInterest(db, SYMBOL_FEATURES, new Date(t0.getTime() - 1 * HOUR_MS), "1200");
    // Another symbol's reading inside the same window/timestamps — must not leak in if the query's
    // symbol filter is ever dropped or wrong.
    await insertOpenInterest(db, SYMBOL_OTHER, new Date(t0.getTime() - 12 * HOUR_MS), "50000");

    // --- long_short_ratio: latest reading at-or-before episodeStartMs. ---
    await insertLongShortRatio(db, SYMBOL_FEATURES, new Date(t0.getTime() - 5 * HOUR_MS), "0.5", "0.5");
    await insertLongShortRatio(db, SYMBOL_FEATURES, t0, "0.7", "0.3"); // exact episodeStartMs, inclusive — the one that must win
    await insertLongShortRatio(db, SYMBOL_FEATURES, new Date(t0.getTime() + 1 * HOUR_MS), "0.9", "0.1"); // after episodeStartMs — must be excluded
    await insertLongShortRatio(db, SYMBOL_OTHER, t0, "0.99", "0.01"); // same instant, other symbol — must not leak in

    // --- liquidations: window is [t0 - 24h, t0] inclusive (liquidationWindowHours=24). ---
    await insertLiquidation(db, SYMBOL_FEATURES, new Date(t0.getTime() - 25 * HOUR_MS), "Buy", "1000", "1"); // just outside window
    await insertLiquidation(db, SYMBOL_FEATURES, new Date(t0.getTime() - 10 * HOUR_MS), "Buy", "2", "100");
    await insertLiquidation(db, SYMBOL_FEATURES, new Date(t0.getTime() - 2 * HOUR_MS), "Sell", "3", "50");
    await insertLiquidation(db, SYMBOL_OTHER, new Date(t0.getTime() - 5 * HOUR_MS), "Buy", "9999", "1"); // other symbol, inside window

    // --- funding volatility: settled funding_timestamp_ms strictly < episodeStartMs, within 720h (30d). ---
    await insertSettled(db, SYMBOL_FEATURES, t0.getTime() - 800 * HOUR_MS, "0.05"); // outside the 720h window
    await insertSettled(db, SYMBOL_FEATURES, t0.getTime() - 240 * HOUR_MS, "0.0007");
    await insertSettled(db, SYMBOL_FEATURES, t0.getTime() - 120 * HOUR_MS, "0.0003");
    await insertSettled(db, SYMBOL_OTHER, t0.getTime() - 100 * HOUR_MS, "0.9"); // other symbol, inside window

    const episodes = await extractFundingEpisodes(db, SYMBOL_FEATURES);

    expect(episodes).toHaveLength(1);
    const { features } = episodes[0]!;

    expect(features.openInterestTrend).toBeDefined();
    expect(features.openInterestTrend!.sampleCount).toBe(2);
    expect(features.openInterestTrend!.earliestOpenInterest.toString()).toBe("1000");
    expect(features.openInterestTrend!.latestOpenInterest.toString()).toBe("1200");
    expect(features.openInterestTrend!.changePercent.toString()).toBe("20");
    expect(features.openInterestTrend!.direction).toBe("up");

    expect(features.longShortRatioAtStart).toBeDefined();
    expect(features.longShortRatioAtStart!.buyRatio.toString()).toBe("0.7");
    expect(features.longShortRatioAtStart!.sellRatio.toString()).toBe("0.3");

    expect(features.recentLiquidationVolume.eventCount).toBe(2);
    expect(features.recentLiquidationVolume.buyVolumeBase.toString()).toBe("2");
    expect(features.recentLiquidationVolume.sellVolumeBase.toString()).toBe("3");
    expect(features.recentLiquidationVolume.notionalVolumeQuote.toString()).toBe("350");

    expect(features.fundingVolatility).toBeDefined();
    expect(features.fundingVolatility!.sampleCount).toBe(2);
    expect(features.fundingVolatility!.meanR8h.toString()).toBe("0.0005");
  });

  it("returns no episodes for a symbol with no predicted funding history at all", async () => {
    const episodes = await extractFundingEpisodes(db, "__TEST_PRED_NEVER_SEEN__USDT");
    expect(episodes).toHaveLength(0);
  });
});
