import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import { csvEscapeField } from "../emulation/reportGenerator.js";
import { extractFundingEpisodes, listKnownSymbols } from "../predictive/episodeExtraction.js";
import type { LabeledFundingEpisode } from "../predictive/episodeExtraction.js";
import { createDb } from "../storage/db.js";

/**
 * OPEN-QUESTIONS.md #22: exports the labeled funding-episode training set
 * (`predictive/episodeExtraction.ts`) to a CSV file for OFFLINE training of a
 * future `PredictiveVetoModel` (`predictive/vetoModel.ts`). Training the
 * model itself is explicitly out of scope for this script and this repo —
 * this only produces the labeled dataset; the actual fit happens in a
 * separate Python/notebook workflow that consumes the CSV this writes.
 *
 * CLI ARGUMENT CONVENTION — a deliberate, documented departure from
 * `backfillFundingHistory.ts`/`fetchMarginTierData.ts`'s top-of-file-const
 * knobs. Those scripts have no natural per-run parameter (their output path
 * is fixed / derived); this one's task explicitly calls for the output path
 * to be an argument, and a hardcoded path here would force editing source to
 * change where a training run's dataset lands. `SYMBOLS` below stays a
 * top-of-file const list, matching the established convention, for the one
 * knob that genuinely is "usually the same every run, edit source when it
 * isn't" — an empty list falls back to every symbol with any `funding_rates`
 * history (`listKnownSymbols`).
 *
 * Run: `node --env-file=.env dist/scripts/exportPredictiveTrainingDataset.js
 * <output.csv> [symbol1,symbol2,...]` (after `npm run build`). The optional
 * second argument, a comma-separated symbol list, overrides `SYMBOLS` below
 * for a single run without editing source. Safe to re-run: always
 * overwrites the output file with a fresh export, same convention as
 * `fetchMarginTierData.ts`.
 */

// Empty = every symbol with any funding_rates history on file (listKnownSymbols).
const SYMBOLS: string[] = [];

const CSV_HEADER = [
  "symbol",
  "episode_start_ms",
  "label",
  "label_window_hours",
  "r8h_at_start",
  "apr_at_start",
  "oi_trend_window_hours",
  "oi_trend_direction",
  "oi_trend_change_percent",
  "oi_trend_sample_count",
  "ls_ratio_buy",
  "ls_ratio_sell",
  "liq_window_hours",
  "liq_buy_volume_base",
  "liq_sell_volume_base",
  "liq_notional_volume_quote",
  "liq_event_count",
  "funding_vol_window_hours",
  "funding_vol_sample_count",
  "funding_vol_mean_r8h",
  "funding_vol_stddev_r8h",
];

// Exported (same convention as runEmulationScenario.ts's computeCoverageHours/
// buildLowCoverageCaveat) purely so this and resolveSymbols below can be unit
// tested without a DB connection — see
// test/scripts/exportPredictiveTrainingDataset.test.ts.
export function episodeToCsvRow(episode: LabeledFundingEpisode): string[] {
  const f = episode.features;
  const oi = f.openInterestTrend;
  const ls = f.longShortRatioAtStart;
  const liq = f.recentLiquidationVolume;
  const vol = f.fundingVolatility;

  return [
    episode.symbol,
    String(episode.episodeStartMs),
    String(episode.label),
    String(episode.labelWindowHours),
    f.r8hAtStart.toString(),
    f.aprAtStart.toString(),
    oi ? String(oi.windowHours) : "",
    oi ? oi.direction : "",
    oi ? oi.changePercent.toString() : "",
    oi ? String(oi.sampleCount) : "",
    ls ? ls.buyRatio.toString() : "",
    ls ? ls.sellRatio.toString() : "",
    String(liq.windowHours),
    liq.buyVolumeBase.toString(),
    liq.sellVolumeBase.toString(),
    liq.notionalVolumeQuote.toString(),
    String(liq.eventCount),
    vol ? String(vol.windowHours) : "",
    vol ? String(vol.sampleCount) : "",
    vol ? vol.meanR8h.toString() : "",
    vol ? vol.stdDevR8h.toString() : "",
  ];
}

/**
 * argv[3] override > top-of-file SYMBOLS const > listKnownSymbols(db)
 * fallback — see this file's own doc comment's "CLI ARGUMENT CONVENTION"
 * section. `fetchKnownSymbols` stands in for `() => listKnownSymbols(db)`:
 * passed as a thunk (not an already-resolved list) so the DB is still only
 * ever queried when actually needed, exactly the original inline ternary's
 * laziness, while keeping this function testable without a DB connection.
 */
export async function resolveSymbols(
  symbolsArg: string | undefined,
  configuredSymbols: string[],
  fetchKnownSymbols: () => Promise<string[]>,
): Promise<string[]> {
  if (symbolsArg) {
    return symbolsArg
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return configuredSymbols.length > 0 ? configuredSymbols : fetchKnownSymbols();
}

function toCsv(episodes: LabeledFundingEpisode[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const episode of episodes) {
    lines.push(episodeToCsvRow(episode).map(csvEscapeField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error(
      "Usage: node dist/scripts/exportPredictiveTrainingDataset.js <output.csv> [symbol1,symbol2,...]",
    );
  }
  const symbolsArg = process.argv[3];

  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const symbols = await resolveSymbols(symbolsArg, SYMBOLS, () => listKnownSymbols(db));

  console.log(`[export-predictive-dataset] ${symbols.length} symbols`);

  const allEpisodes: LabeledFundingEpisode[] = [];
  for (const symbol of symbols) {
    const episodes = await extractFundingEpisodes(db, symbol);
    allEpisodes.push(...episodes);
    console.log(`[export-predictive-dataset] ${symbol}: ${episodes.length} labeled episodes`);
  }

  await writeFile(outputPath, toCsv(allEpisodes), "utf8");

  const positives = allEpisodes.filter((e) => e.label).length;
  console.log(`\n[export-predictive-dataset] wrote ${allEpisodes.length} rows to ${outputPath}`);
  console.log(`[export-predictive-dataset] label balance: ${positives}/${allEpisodes.length} positive`);

  await db.destroy();
}

// Guarded so importing this module (e.g. test/scripts/exportPredictiveTrainingDataset.test.ts,
// to exercise resolveSymbols/episodeToCsvRow in isolation) never triggers a
// real run — only a direct `node .../exportPredictiveTrainingDataset.js`
// invocation does. Same pattern as runEmulationScenario.ts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[export-predictive-dataset] fatal:", e);
    process.exit(1);
  });
}
