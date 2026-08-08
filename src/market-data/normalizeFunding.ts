import Big from "big.js";

/**
 * RSK-25 / FM-04 (RISK-REGISTER.md): Bybit funding intervals are NOT uniformly 8h —
 * a live snapshot found 408 symbols at 240min, 344 at 480min, 2 at 60min, and Bybit
 * switches a symbol to hourly settlement without notice when its rate pins to the cap.
 * Every comparison between symbols MUST go through this normalization; comparing raw
 * per-interval rates across symbols with different intervals silently favours whichever
 * symbol happens to settle more often.
 */

// The canonical "r8h" basis — exported so any caller computing "how many r8h
// periods fit in a window of T minutes" (T / REFERENCE_INTERVAL_MINUTES) uses
// the SAME constant this function normalizes against, rather than a symbol's
// own (irrelevant, once already normalized to r8h) intervalMinutes.
export const REFERENCE_INTERVAL_MINUTES = 480;
const HOURS_PER_YEAR = 24 * 365;
const MINUTES_PER_HOUR = 60;

/**
 * Converts a per-interval funding rate to the canonical 8h-equivalent rate ("r8h").
 * Pure and total for any positive interval — deliberately does NOT restrict to the
 * currently-known {60,120,240,480} set, because a live `fundingInterval` field read
 * from instruments-info is authoritative by construction; hardcoding the known set here
 * would repeat exactly the mistake FM-04 documents (assuming today's intervals are all
 * intervals that will ever exist).
 */
export function normalizeFundingRateToR8h(rate: Big, intervalMinutes: number): Big {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new RangeError(`intervalMinutes must be a positive finite number, got ${intervalMinutes}`);
  }
  return rate.times(REFERENCE_INTERVAL_MINUTES).div(intervalMinutes);
}

/**
 * Simple (non-compounded) annualization of an r8h rate — the convention used
 * throughout RISK-REGISTER.md's economics analysis (FM-01, FM-07).
 */
export function r8hToApr(r8h: Big): Big {
  const periodsPerYear = new Big(HOURS_PER_YEAR).div(8);
  return r8h.times(periodsPerYear);
}

const KNOWN_INTERVAL_MINUTES = new Set([60, 120, 240, 480]);

/**
 * RSK-25 / FM-04: raw historical funding data (`/v5/market/funding/history`) does not
 * carry an interval field at all — it must be inferred from the gap between consecutive
 * settlement timestamps. Naively averaging "%/8h" over a history containing undetected
 * interval changes silently understates the true rate (RISK-REGISTER documents 26
 * consecutive 120-minute SOLUSDT settlements being folded into an 8h aggregation).
 *
 * This function refuses to guess: an interval outside the currently-known set is a loud
 * failure (a data gap or an undocumented new interval), never a silent average.
 */
export function deriveIntervalMinutesFromTimestamps(
  earlierTimestampMs: number,
  laterTimestampMs: number,
): number {
  const deltaMinutes = (laterTimestampMs - earlierTimestampMs) / (1000 * MINUTES_PER_HOUR);
  if (!KNOWN_INTERVAL_MINUTES.has(deltaMinutes)) {
    throw new RangeError(
      `Funding settlement gap of ${deltaMinutes} minutes is outside the known interval set ` +
        `{${[...KNOWN_INTERVAL_MINUTES].join(",")}} — refusing to silently average across it ` +
        `(RISK-REGISTER.md FM-04). Likely a data gap or a new Bybit interval; investigate before proceeding.`,
    );
  }
  return deltaMinutes;
}
