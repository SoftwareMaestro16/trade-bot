import Big from "big.js";
import { normalizeFundingRateToR8h, r8hToApr } from "../market-data/normalizeFunding.js";

/**
 * OPEN-QUESTIONS.md #22: feature/label shape for the (not-yet-existing) predictive
 * veto model — "доживёт ли положительный funding следующие N часов". This module
 * is DB-free by design ("легко тестировать без БД"): every function here is pure,
 * taking already-loaded row slices as plain parameters. `episodeExtraction.ts` is
 * the only place in `predictive/` that talks to Kysely; it converts DB rows into
 * the `*Sample` shapes below and hands them to `computeFundingEpisodeFeatures`.
 *
 * All money/rate fields are `Big` (ADR-003) — parsing a DB row's `string` column
 * into `Big` is the caller's job, same convention as `market-data/types.ts`.
 */

/**
 * One open-interest reading. `timestampMs` is deliberately the row's
 * `fetched_at` (collector receive time), NOT `data_timestamp_ms` (the
 * exchange's own reporting timestamp for the metric) — `fetched_at` is the
 * same look-ahead-safe "when did we actually know this" axis
 * `scenarioRunner.ts`'s own `latestOpenInterestAtOrBefore` gates on, and using
 * a single consistent axis here avoids a silent mismatch between how
 * `episodeExtraction.ts` bounds its query and how this module windows the
 * result.
 */
export interface OpenInterestSample {
  timestampMs: number;
  openInterest: Big;
}

/** Single latest-at-or-before-episode-start reading — there is no "trend" concept for long/short ratio here, only a snapshot (see `FundingEpisodeFeatures.longShortRatioAtStart`'s own doc comment). */
export interface LongShortRatioSample {
  buyRatio: Big;
  sellRatio: Big;
}

/** One liquidation event. `timestampMs` is `received_at` (collector receive time) — same look-ahead-safe-axis reasoning as `OpenInterestSample.timestampMs` above, `liquidations`' analogous column to `fetched_at`. */
export interface LiquidationSample {
  timestampMs: number;
  side: "Buy" | "Sell";
  size: Big;
  price: Big;
}

/** One settled funding settlement. `rate` is the raw per-interval rate, not yet normalized — normalization happens inside this module via `normalizeFundingRateToR8h`, once per sample, using that sample's OWN `intervalMinutes` (naturally correct across an interval change mid-history, no need to re-derive via `deriveIntervalMinutesFromTimestamps`). */
export interface SettledFundingSample {
  fundingTimestampMs: number;
  intervalMinutes: number;
  rate: Big;
}

export interface OpenInterestTrend {
  windowHours: number;
  direction: "up" | "down" | "flat";
  /** Signed percent change from the earliest to the latest sample inside the window, e.g. `Big("12.5")` = +12.5%. */
  changePercent: Big;
  earliestOpenInterest: Big;
  latestOpenInterest: Big;
  sampleCount: number;
}

/**
 * Always defined, unlike `openInterestTrend`/`fundingVolatility` below — a
 * window with zero liquidation events is a genuinely meaningful reading ("no
 * forced liquidations recently"), not a missing-data case, so it is reported
 * as `eventCount: 0` rather than `undefined`.
 */
export interface RecentLiquidationVolume {
  windowHours: number;
  buyVolumeBase: Big;
  sellVolumeBase: Big;
  notionalVolumeQuote: Big;
  eventCount: number;
}

export interface FundingVolatility {
  windowHours: number;
  sampleCount: number;
  meanR8h: Big;
  /** Sample standard deviation (n-1 denominator, Bessel's correction) of r8h-normalized settled rates inside the window. */
  stdDevR8h: Big;
}

export interface FundingEpisodeFeatures {
  symbol: string;
  episodeStartMs: number;

  r8hAtStart: Big;
  aprAtStart: Big;

  /**
   * `undefined` when fewer than two open-interest samples fall inside the
   * window, or when the earliest sample's open interest is exactly zero (a
   * percent change against a zero baseline is undefined, not infinite or
   * zero) — "refuse to guess" rather than silently reporting a `0%`/`flat`
   * trend that would look identical to "genuinely observed no change"
   * (mirrors `normalizeFunding.ts`'s `deriveIntervalMinutesFromTimestamps`
   * house style of a loud absence over a silent, wrong default).
   */
  openInterestTrend: OpenInterestTrend | undefined;

  /** Latest long/short ratio at-or-before `episodeStartMs`; `undefined` if the symbol has no reading before that instant. */
  longShortRatioAtStart: LongShortRatioSample | undefined;

  recentLiquidationVolume: RecentLiquidationVolume;

  /**
   * `undefined` when fewer than two settled-funding samples fall inside the
   * window — a single settlement has no spread to measure, and reporting
   * `stdDevR8h: 0` for it would misleadingly read as "observed perfectly
   * stable" rather than "not enough history yet". Same "refuse to guess"
   * reasoning as `openInterestTrend` above.
   */
  fundingVolatility: FundingVolatility | undefined;
}

export interface ComputeFundingEpisodeFeaturesInput {
  symbol: string;
  episodeStartMs: number;
  /** Raw per-interval rate at episode start — typically the `kind='predicted'` row whose normalized r8h first cleared the entry floor (see `episodeExtraction.ts`). This function itself is agnostic to where the rate came from; it only normalizes it. */
  startRate: Big;
  startIntervalMinutes: number;
  /**
   * Any slice of open-interest samples the caller has loaded — does NOT need
   * to be pre-trimmed to `openInterestTrendWindowHours`; this function does
   * its own window filtering internally (`timestampMs <= episodeStartMs &&
   * timestampMs >= episodeStartMs - window`), so callers can safely pass a
   * broader slice without corrupting the computed trend. Same applies to
   * `liquidationHistory`/`fundingHistory` below.
   */
  openInterestHistory: OpenInterestSample[];
  longShortRatioAtStart: LongShortRatioSample | undefined;
  liquidationHistory: LiquidationSample[];
  /** Settled funding history STRICTLY BEFORE `episodeStartMs` — this function filters to `fundingTimestampMs < episodeStartMs`, i.e. it never uses a sample dated exactly at or after episode start, keeping this feature disjoint from `r8hAtStart` (which already reports the start rate itself). */
  fundingHistory: SettledFundingSample[];
}

export interface FundingEpisodeFeatureWindows {
  openInterestTrendWindowHours: number;
  liquidationWindowHours: number;
  fundingVolatilityWindowHours: number;
}

/**
 * Defaults, all overridable per call:
 * - `openInterestTrendWindowHours = 24`: OI drifts on a day-scale timeframe;
 *   one full day captures a complete cycle without reaching back into an
 *   unrelated regime.
 * - `liquidationWindowHours = 24`: a liquidation cascade is the most
 *   up-to-the-minute market-stress signal that can precede a funding sign
 *   flip; 24h is long enough to catch one a few hours ahead of episode start
 *   while staying "recent" in the sense the feature name implies.
 * - `fundingVolatilityWindowHours = 24*30 = 720` (30 days): gives a
 *   reasonable sample count even for an 8h-interval symbol (~90 settlements)
 *   without reaching back far enough to mix in a different funding regime.
 */
export const DEFAULT_FEATURE_WINDOWS: FundingEpisodeFeatureWindows = {
  openInterestTrendWindowHours: 24,
  liquidationWindowHours: 24,
  fundingVolatilityWindowHours: 24 * 30,
};

function withinWindowInclusive(timestampMs: number, endMs: number, windowHours: number): boolean {
  const windowMs = windowHours * 60 * 60 * 1000;
  return timestampMs <= endMs && timestampMs >= endMs - windowMs;
}

function computeOpenInterestTrend(
  samples: OpenInterestSample[],
  episodeStartMs: number,
  windowHours: number,
): OpenInterestTrend | undefined {
  const inWindow = samples
    .filter((s) => withinWindowInclusive(s.timestampMs, episodeStartMs, windowHours))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (inWindow.length < 2) return undefined;

  const earliest = inWindow[0]!;
  const latest = inWindow[inWindow.length - 1]!;

  if (earliest.openInterest.eq(0)) return undefined;

  const changePercent = latest.openInterest.minus(earliest.openInterest).div(earliest.openInterest).times(100);
  const direction = changePercent.gt(0) ? "up" : changePercent.lt(0) ? "down" : "flat";

  return {
    windowHours,
    direction,
    changePercent,
    earliestOpenInterest: earliest.openInterest,
    latestOpenInterest: latest.openInterest,
    sampleCount: inWindow.length,
  };
}

function computeRecentLiquidationVolume(
  samples: LiquidationSample[],
  episodeStartMs: number,
  windowHours: number,
): RecentLiquidationVolume {
  const inWindow = samples.filter((s) => withinWindowInclusive(s.timestampMs, episodeStartMs, windowHours));

  let buyVolumeBase = new Big(0);
  let sellVolumeBase = new Big(0);
  let notionalVolumeQuote = new Big(0);

  for (const sample of inWindow) {
    notionalVolumeQuote = notionalVolumeQuote.plus(sample.size.times(sample.price));
    if (sample.side === "Buy") {
      buyVolumeBase = buyVolumeBase.plus(sample.size);
    } else {
      sellVolumeBase = sellVolumeBase.plus(sample.size);
    }
  }

  return { windowHours, buyVolumeBase, sellVolumeBase, notionalVolumeQuote, eventCount: inWindow.length };
}

function computeFundingVolatility(
  samples: SettledFundingSample[],
  episodeStartMs: number,
  windowHours: number,
): FundingVolatility | undefined {
  const windowMs = windowHours * 60 * 60 * 1000;
  const inWindow = samples.filter(
    (s) => s.fundingTimestampMs < episodeStartMs && s.fundingTimestampMs >= episodeStartMs - windowMs,
  );

  if (inWindow.length < 2) return undefined;

  const r8hValues = inWindow.map((s) => normalizeFundingRateToR8h(s.rate, s.intervalMinutes));
  const sum = r8hValues.reduce((acc, v) => acc.plus(v), new Big(0));
  const meanR8h = sum.div(r8hValues.length);
  const sumSquaredDeviations = r8hValues.reduce((acc, v) => acc.plus(v.minus(meanR8h).pow(2)), new Big(0));
  const variance = sumSquaredDeviations.div(r8hValues.length - 1); // n-1: Bessel's correction
  const stdDevR8h = variance.sqrt();

  return { windowHours, sampleCount: r8hValues.length, meanR8h, stdDevR8h };
}

/**
 * Pure feature computation for one funding episode. Never touches a database
 * or a clock — every input is a plain value or an already-loaded row slice,
 * so this is directly unit-testable without Postgres (see
 * `test/predictive/episodeFeatures.test.ts`).
 */
export function computeFundingEpisodeFeatures(
  input: ComputeFundingEpisodeFeaturesInput,
  windows: FundingEpisodeFeatureWindows = DEFAULT_FEATURE_WINDOWS,
): FundingEpisodeFeatures {
  const r8hAtStart = normalizeFundingRateToR8h(input.startRate, input.startIntervalMinutes);
  const aprAtStart = r8hToApr(r8hAtStart);

  return {
    symbol: input.symbol,
    episodeStartMs: input.episodeStartMs,
    r8hAtStart,
    aprAtStart,
    openInterestTrend: computeOpenInterestTrend(
      input.openInterestHistory,
      input.episodeStartMs,
      windows.openInterestTrendWindowHours,
    ),
    longShortRatioAtStart: input.longShortRatioAtStart,
    recentLiquidationVolume: computeRecentLiquidationVolume(
      input.liquidationHistory,
      input.episodeStartMs,
      windows.liquidationWindowHours,
    ),
    fundingVolatility: computeFundingVolatility(
      input.fundingHistory,
      input.episodeStartMs,
      windows.fundingVolatilityWindowHours,
    ),
  };
}
