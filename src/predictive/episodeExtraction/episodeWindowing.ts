import Big from "big.js";
import { normalizeFundingRateToR8h } from "../../market-data/normalizeFunding.js";
import { ENTRY_FLOOR_R8H } from "../../risk/economics.js";

// Split out of predictive/episodeExtraction.ts — see episodeExtraction/extract.ts's
// module doc comment for full context (look-ahead discipline, episode definition,
// label window). This file holds episode-start detection only.

export interface EpisodeStart {
  episodeStartMs: number;
  startRate: Big;
  startIntervalMinutes: number;
}

export interface PredictedFundingRow {
  rate: string;
  interval_minutes: number;
  fetched_at: Date;
}

/**
 * Walks one symbol's `kind='predicted'` history in fetched_at order and
 * returns the first row of each maximal contiguous run at/above
 * `ENTRY_FLOOR_R8H` — see module doc comment's "EPISODE DEFINITION".
 */
export function findEpisodeStarts(rows: PredictedFundingRow[]): EpisodeStart[] {
  const starts: EpisodeStart[] = [];
  let wasAboveFloor = false;

  for (const row of rows) {
    const rate = new Big(row.rate);
    const r8h = normalizeFundingRateToR8h(rate, row.interval_minutes);
    const isAboveFloor = r8h.gte(ENTRY_FLOOR_R8H);

    if (isAboveFloor && !wasAboveFloor) {
      starts.push({
        episodeStartMs: row.fetched_at.getTime(),
        startRate: rate,
        startIntervalMinutes: row.interval_minutes,
      });
    }
    wasAboveFloor = isAboveFloor;
  }

  return starts;
}
