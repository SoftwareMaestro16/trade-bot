/**
 * Thin barrel re-export — this module's own doc comment (look-ahead
 * discipline, episode definition, label window) and its main implementation
 * (`extractFundingEpisodes`, `listKnownSymbols`) live in
 * `episodeExtraction/extract.ts`. The rest of the split:
 *   - `episodeExtraction/episodeWindowing.ts` — episode-start detection.
 *   - `episodeExtraction/fetchers.ts` — feature-window DB reads.
 *   - `episodeExtraction/survivalLabel.ts` — forward-looking survival label.
 */
export * from "./episodeExtraction/extract.js";
