import type { Kysely } from "kysely";
import type { Database } from "../../storage/schema.js";
import { computeFundingEpisodeFeatures, DEFAULT_FEATURE_WINDOWS } from "../episodeFeatures.js";
import type { FundingEpisodeFeatures, FundingEpisodeFeatureWindows } from "../episodeFeatures.js";
import { findEpisodeStarts } from "./episodeWindowing.js";
import type { EpisodeStart } from "./episodeWindowing.js";
import {
  fetchFundingVolatilityHistory,
  fetchLiquidationWindow,
  fetchLongShortRatioAtStart,
  fetchOpenInterestWindow,
} from "./fetchers.js";
import { computeSurvivalLabel } from "./survivalLabel.js";

/**
 * OPEN-QUESTIONS.md #22 training-data extraction: turns raw history in
 * `funding_rates`/`open_interest`/`long_short_ratio`/`liquidations` into
 * labeled funding episodes for offline training of a future
 * `PredictiveVetoModel` (`vetoModel.ts`). This module DOES read the database
 * (unlike `episodeFeatures.ts`, which stays pure) — it is the one place in
 * `predictive/` allowed to.
 *
 * ============================================================================
 * LOOK-AHEAD DISCIPLINE — read this before touching this file
 * ============================================================================
 * This module mirrors `emulation/scenarioRunner.ts`'s own "LOOK-AHEAD
 * DISCIPLINE" doc comment, with ONE deliberate, ADDITIONAL carve-out beyond
 * the two that file already documents. All three are laid out here so
 * nobody has to reconstruct the reasoning from a diff:
 *
 * 1. FEATURE reads (open interest, long/short ratio, liquidations) are gated
 *    `fetched_at <= episodeStartMs` — the ordinary rule, identical to
 *    `scenarioRunner.ts`'s `latestOpenInterestAtOrBefore` /
 *    `latestLongShortRatioAtOrBefore`. This keeps every feature this module
 *    produces "knowable" at the instant a live decision process would have
 *    evaluated the episode, which matters because these features are meant
 *    to train a model that WILL eventually sit in a decision path.
 *
 * 2. The LABEL ("did funding stay above the entry floor for the next N
 *    hours") reads `kind='settled'` rows gated by `funding_timestamp_ms`,
 *    NOT `fetched_at` — exactly `scenarioRunner.ts`'s own `settledFundingSince`
 *    carve-out, for exactly its own reason: a settlement is economically real
 *    at `funding_timestamp_ms` regardless of when a historical-sweep
 *    collector happened to record it. THIS IS RETROSPECTIVE LABELING FOR A
 *    TRAINING SET, NOT A LIVE DECISION — do not copy this gating pattern into
 *    any live entry/exit code path. A live decision may only ever read
 *    `kind='predicted'` funding, never `kind='settled'` for a still-open
 *    question about the future.
 *
 * 3. The FUNDING-VOLATILITY FEATURE ("историческая волатильность funding...
 *    за предыдущий период") ALSO reads `kind='settled'` rows gated by
 *    `funding_timestamp_ms < episodeStartMs`, not `fetched_at`. This is a
 *    third, deliberate case distinct from both of the above: unlike the
 *    label (which looks FORWARD from episode start, purely retrospective by
 *    construction) this is a FEATURE (an input a model would consume), yet
 *    it still isn't gated by `fetched_at` the way features #1 above are.
 *    The reason is what's being measured: a settlement dated well BEFORE
 *    `episodeStartMs` is public, already-realized economic history the
 *    instant it settles — a live bot could always learn it via a direct call
 *    to Bybit's `/v5/market/funding/history` endpoint, independent of
 *    whether THIS project's own collector happened to sweep it into
 *    `funding_rates` before or after `episodeStartMs`. Gating this read by
 *    our own collector's `fetched_at` would make the feature depend on OUR
 *    collector's incidental scheduling lag rather than on genuine economic
 *    knowability — exactly the same "was this economically real by time T"
 *    reasoning `settledFundingSince` already applies to crediting funding,
 *    just reused here for a historical feature instead of a live credit.
 *
 * ============================================================================
 * EPISODE DEFINITION
 * ============================================================================
 * An episode is a maximal contiguous run of `kind='predicted'` readings for
 * one symbol whose normalized r8h is at/above `ENTRY_FLOOR_R8H` — its start
 * (`episodeStartMs`) is the `fetched_at` of the FIRST predicted row in that
 * run (the first row where r8h crosses up to/above the floor, whether from
 * below the floor or from the very first predicted row on file for that
 * symbol). `ENTRY_FLOOR_R8H` is imported from `risk/economics.ts`, not
 * re-derived or re-hardcoded from scratch, so this module's episode-start
 * detection and survival label always move with the live entry gate.
 * Because the floor (0.020%/8h) is itself strictly positive, "r8h >= floor"
 * already implies "funding is positive" — there is no separate sign check to
 * apply on top.
 *
 * (Episode-start detection itself — `findEpisodeStarts` — now lives in
 * `episodeExtraction/episodeWindowing.ts`.)
 *
 * ============================================================================
 * LABEL WINDOW (N HOURS) AND RIGHT-CENSORING
 * ============================================================================
 * `DEFAULT_LABEL_WINDOW_HOURS = 72` (3 days) is chosen to match
 * PARAMS-CONSERVATIVE.md §5's own "круг комиссий должен окупаться за ≤ 3
 * суток" payback horizon — the same figure `emulation/scenarioRunner.ts`
 * already anchors `expectedHoldIntervals` on via its own
 * `EXPECTED_PAYBACK_MINUTES = 3*24*60`. Reusing it here means the predictive
 * model's forward-looking question ("will this still look good through the
 * whole horizon the rest of the codebase already treats as the minimum
 * worthwhile hold") lines up with an existing, reasoned number instead of
 * inventing an unrelated one.
 *
 * An episode is EXCLUDED from the returned set (never labeled true or false
 * by default) whenever the outcome can't actually be known yet:
 *   - Right-censored: the symbol's settled-funding history doesn't reach
 *     `episodeStartMs + N hours` at all (end of collected history, or the
 *     symbol was delisted/stopped being collected mid-window).
 *   - Gapped: settled history DOES reach past the window boundary, but zero
 *     settled rows actually fall inside `(episodeStartMs, episodeStartMs + N
 *     hours]` — a collector gap spanning exactly this episode's window. Both
 *     cases mean "unknown", not "assume positive" or "assume negative".
 *
 * (The survival-label computation itself — `computeSurvivalLabel` — now
 * lives in `episodeExtraction/survivalLabel.ts`; the per-episode feature-window
 * DB reads it doesn't cover live in `episodeExtraction/fetchers.ts`.)
 */

/** See module doc comment's "LABEL WINDOW" section for why 72h. */
export const DEFAULT_LABEL_WINDOW_HOURS = 72;

export interface EpisodeExtractionOptions {
  /** Forward-looking survival window, in hours. Default: `DEFAULT_LABEL_WINDOW_HOURS`. */
  labelWindowHours?: number;
  /** Feature lookback windows — default: `episodeFeatures.ts`'s own `DEFAULT_FEATURE_WINDOWS`. */
  featureWindows?: FundingEpisodeFeatureWindows;
}

export interface LabeledFundingEpisode {
  symbol: string;
  episodeStartMs: number;
  features: FundingEpisodeFeatures;
  /** true = funding stayed at/above ENTRY_FLOOR_R8H for every settled reading in `(episodeStartMs, episodeStartMs + labelWindowHours]`. */
  label: boolean;
  labelWindowHours: number;
}

async function buildFeaturesForEpisode(
  db: Kysely<Database>,
  symbol: string,
  start: EpisodeStart,
  windows: FundingEpisodeFeatureWindows,
): Promise<FundingEpisodeFeatures> {
  const [openInterestHistory, longShortRatioAtStart, liquidationHistory, fundingHistory] = await Promise.all([
    fetchOpenInterestWindow(db, symbol, start.episodeStartMs, windows.openInterestTrendWindowHours),
    fetchLongShortRatioAtStart(db, symbol, start.episodeStartMs),
    fetchLiquidationWindow(db, symbol, start.episodeStartMs, windows.liquidationWindowHours),
    fetchFundingVolatilityHistory(db, symbol, start.episodeStartMs, windows.fundingVolatilityWindowHours),
  ]);

  return computeFundingEpisodeFeatures(
    {
      symbol,
      episodeStartMs: start.episodeStartMs,
      startRate: start.startRate,
      startIntervalMinutes: start.startIntervalMinutes,
      openInterestHistory,
      longShortRatioAtStart,
      liquidationHistory,
      fundingHistory,
    },
    windows,
  );
}

/**
 * Extracts every labeled funding episode for one symbol. Reads
 * `funding_rates`/`open_interest`/`long_short_ratio`/`liquidations` — see
 * module doc comment for the exact look-ahead-discipline gate each read
 * uses. Pure DB round-trips aside, all actual feature/label arithmetic is
 * delegated to `episodeFeatures.ts`'s pure functions.
 */
export async function extractFundingEpisodes(
  db: Kysely<Database>,
  symbol: string,
  options: EpisodeExtractionOptions = {},
): Promise<LabeledFundingEpisode[]> {
  const labelWindowHours = options.labelWindowHours ?? DEFAULT_LABEL_WINDOW_HOURS;
  const featureWindows = options.featureWindows ?? DEFAULT_FEATURE_WINDOWS;
  const labelWindowMs = labelWindowHours * 60 * 60 * 1000;

  const predictedRows = await db
    .selectFrom("funding_rates")
    .select(["rate", "interval_minutes", "fetched_at"])
    .where("symbol", "=", symbol)
    .where("kind", "=", "predicted")
    .orderBy("fetched_at", "asc")
    .execute();

  const starts = findEpisodeStarts(predictedRows);
  if (starts.length === 0) return [];

  const coverageRow = await db
    .selectFrom("funding_rates")
    .select(({ fn }) => fn.max("funding_timestamp_ms").as("maxSettledTs"))
    .where("symbol", "=", symbol)
    .where("kind", "=", "settled")
    .executeTakeFirst();
  const maxSettledTsMs = coverageRow?.maxSettledTs ? Number(coverageRow.maxSettledTs) : undefined;

  const episodes: LabeledFundingEpisode[] = [];

  for (const start of starts) {
    const windowEndMs = start.episodeStartMs + labelWindowMs;

    // Right-censored: settled history for this symbol doesn't reach the end
    // of this episode's window yet — dropped, never defaulted (module doc
    // comment).
    if (maxSettledTsMs === undefined || maxSettledTsMs < windowEndMs) continue;

    const label = await computeSurvivalLabel(db, symbol, start.episodeStartMs, windowEndMs);
    if (label === undefined) continue; // gapped coverage inside the window — see computeSurvivalLabel's own comment

    const features = await buildFeaturesForEpisode(db, symbol, start, featureWindows);
    episodes.push({ symbol, episodeStartMs: start.episodeStartMs, features, label, labelWindowHours });
  }

  return episodes;
}

/** Every symbol with ANY `funding_rates` history on file — convenience for a CLI script's "all symbols" default (`scripts/exportPredictiveTrainingDataset.ts`). */
export async function listKnownSymbols(db: Kysely<Database>): Promise<string[]> {
  const rows = await db.selectFrom("funding_rates").select("symbol").distinct().orderBy("symbol", "asc").execute();
  return rows.map((r) => r.symbol);
}
