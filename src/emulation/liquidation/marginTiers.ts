import { readFileSync } from "node:fs";
import path from "node:path";
import Big from "big.js";

/**
 * Margin tier data / risk-limit lookup — split out of `../liquidation.ts`
 * (see that file's own top-level doc comment for full citation sources 1-8,
 * which this section's comments below reference by number).
 */

// ---------------------------------------------------------------------------
// Margin tiers (risk-limit lookup)
// ---------------------------------------------------------------------------

export type MarginTierSource = "bybit-api-snapshot" | "conservative-placeholder";

/**
 * One row of a symbol's risk-limit tier ladder. Field names mirror Bybit's
 * own `GET /v5/market/risk-limit` response fields 1:1 (`maintenanceMargin` ->
 * `maintenanceMarginRate`, `initialMargin` -> `initialMarginRate`,
 * `riskLimitValue`, `maxLeverage`, `mmDeduction`) so a live API response can
 * be mapped onto this shape without renaming, once that ingestion is wired up
 * (see this module's own top-level doc comment, source 6, and open_questions
 * in the PR/task description for why that ingestion is NOT built here).
 */
export interface MarginTier {
  /** 1-based rank within the symbol's ladder, ascending risk (1 = isLowestRisk in Bybit's API). */
  tier: number;
  /**
   * Upper bound (USDT) of position notional this tier covers. Source 7:
   * "when you open a BTCUSDT position with a position value of 2,000,000 USDT
   * or below, the maintenance margin rate (MMR) required for the position is
   * 0.5%" — "or below" is why tier lookup below uses an INCLUSIVE `<=` at
   * this boundary, not a strict `<`.
   */
  riskLimitValue: Big;
  /** Bybit's `maintenanceMargin` field — a fraction (0.005 = 0.5%), not a percent. */
  maintenanceMarginRate: Big;
  /** Bybit's `initialMargin` field — a fraction, not a percent. */
  initialMarginRate: Big;
  /** Bybit's `maxLeverage` field for this tier. */
  maxLeverage: Big;
  /**
   * Bybit's `mmDeduction` field: a linear correction constant subtracted in
   * the Maintenance Margin formula (see `computeMaintenanceMargin`). The risk
   * limit tier system charges a position's ENTIRE notional the selected
   * tier's flat MMR rather than a graduated/marginal per-bracket sum (unlike,
   * e.g., a tax bracket) — `mmDeduction` is Bybit's own constant that keeps
   * that flat-rate shortcut continuous across tier boundaries instead of
   * jumping discontinuously at each one. Always 0 for tier 1 (the API returns
   * `""` for tier 1's `mmDeduction`, since there is nothing below it to
   * correct for).
   */
  mmDeduction: Big;
  /**
   * `"bybit-api-snapshot"` for a tier transcribed from a real, dated API
   * response (see the tier table's own doc comment for the capture date);
   * `"conservative-placeholder"` for `FALLBACK_CONSERVATIVE_TIER`, which is
   * NOT observed Bybit data for any symbol. A caller about to risk real
   * capital on a specific symbol should check this field and refuse to trade
   * on a `"conservative-placeholder"` tier rather than silently accepting an
   * approximation — this module does not enforce that itself (it has no veto
   * power; see ARCHITECTURE.md §2, risk/ owns vetoes, not emulation/).
   */
  source: MarginTierSource;
}

export type MarginTierTable = Readonly<Record<string, readonly MarginTier[]>>;

/** Internal: converts a compact tuple row into a fully-typed, Big-valued MarginTier. */
function buildTier(
  tier: number,
  riskLimitValue: string,
  maintenanceMarginRate: string,
  initialMarginRate: string,
  maxLeverage: string,
  mmDeduction: string,
  source: MarginTierSource,
): MarginTier {
  return {
    tier,
    riskLimitValue: new Big(riskLimitValue),
    maintenanceMarginRate: new Big(maintenanceMarginRate),
    initialMarginRate: new Big(initialMarginRate),
    maxLeverage: new Big(maxLeverage),
    mmDeduction: new Big(mmDeduction),
    source,
  };
}

/**
 * [riskLimitValue, maintenanceMargin, initialMargin, maxLeverage, mmDeduction]
 * per tier, transcribed verbatim (field order matches the raw API's own field
 * order) from a live snapshot of `GET /v5/market/risk-limit?category=linear&
 * symbol=BTCUSDT`, captured 2026-08-05. Tier 1's `mmDeduction` was `""` in the
 * raw response (no correction below the lowest tier) and is written here as
 * `"0"`.
 *
 * Cross-checked against source 7's own worked example, independent of the
 * captured API snapshot: "position value of 2,000,000 USDT or below ... MMR
 * ... 0.5% ... if the position value increases to 2,600,000 USDT, the MMR
 * required will also increase to 0.56%" — matches tier 1 (riskLimitValue
 * 2,000,000 / MMR 0.005) and tier 2 (riskLimitValue 2,600,000 / MMR 0.0056)
 * below exactly.
 */
const BTCUSDT_TIERS: readonly MarginTier[] = [
  buildTier(1, "2000000", "0.005", "0.01", "100.00", "0", "bybit-api-snapshot"),
  buildTier(2, "2600000", "0.0056", "0.0111", "90.00", "1200", "bybit-api-snapshot"),
  buildTier(3, "3200000", "0.0063", "0.0125", "80.00", "3020", "bybit-api-snapshot"),
  buildTier(4, "3800000", "0.0067", "0.0133", "75.00", "4300", "bybit-api-snapshot"),
  buildTier(5, "4400000", "0.0071", "0.0143", "70.00", "5820", "bybit-api-snapshot"),
  buildTier(6, "5000000", "0.0077", "0.0154", "65.00", "8460", "bybit-api-snapshot"),
  buildTier(7, "5600000", "0.0091", "0.0182", "55.00", "15460", "bybit-api-snapshot"),
  buildTier(8, "8500000", "0.01", "0.02", "50.00", "20500", "bybit-api-snapshot"),
  buildTier(9, "10000000", "0.013", "0.0222", "45.00", "46000", "bybit-api-snapshot"),
  buildTier(10, "14000000", "0.015", "0.025", "40.00", "66000", "bybit-api-snapshot"),
  buildTier(11, "20000000", "0.016", "0.0286", "35.00", "80000", "bybit-api-snapshot"),
  buildTier(12, "28000000", "0.02", "0.0333", "30.00", "160000", "bybit-api-snapshot"),
  buildTier(13, "38000000", "0.025", "0.04", "25.00", "300000", "bybit-api-snapshot"),
  buildTier(14, "50000000", "0.029", "0.05", "20.00", "452000", "bybit-api-snapshot"),
  buildTier(15, "55000000", "0.03", "0.0526", "19.00", "502000", "bybit-api-snapshot"),
  buildTier(16, "60000000", "0.035", "0.0556", "18.00", "777000", "bybit-api-snapshot"),
  buildTier(17, "65000000", "0.036", "0.0588", "17.00", "837000", "bybit-api-snapshot"),
  buildTier(18, "70000000", "0.038", "0.0625", "16.00", "967000", "bybit-api-snapshot"),
  buildTier(19, "75000000", "0.04", "0.0667", "15.00", "1107000", "bybit-api-snapshot"),
  buildTier(20, "80000000", "0.045", "0.0714", "14.00", "1482000", "bybit-api-snapshot"),
  buildTier(21, "85000000", "0.05", "0.0769", "13.00", "1882000", "bybit-api-snapshot"),
  buildTier(22, "90000000", "0.055", "0.0833", "12.00", "2307000", "bybit-api-snapshot"),
  buildTier(23, "95000000", "0.06", "0.0909", "11.00", "2757000", "bybit-api-snapshot"),
  buildTier(24, "100000000", "0.065", "0.1", "10.00", "3232000", "bybit-api-snapshot"),
  buildTier(25, "105000000", "0.07", "0.1111", "9.00", "3732000", "bybit-api-snapshot"),
  buildTier(26, "110000000", "0.085", "0.125", "8.00", "5307000", "bybit-api-snapshot"),
  buildTier(27, "115000000", "0.095", "0.1429", "7.00", "6407000", "bybit-api-snapshot"),
  buildTier(28, "120000000", "0.1", "0.1667", "6.00", "6982000", "bybit-api-snapshot"),
  buildTier(29, "150000000", "0.12", "0.2", "5.00", "9382000", "bybit-api-snapshot"),
  buildTier(30, "200000000", "0.14", "0.25", "4.00", "12382000", "bybit-api-snapshot"),
  buildTier(31, "250000000", "0.18", "0.3333", "3.00", "20382000", "bybit-api-snapshot"),
  buildTier(32, "400000000", "0.3", "0.5", "2.00", "50382000", "bybit-api-snapshot"),
  buildTier(33, "600000000", "0.42", "0.6993", "1.43", "98382000", "bybit-api-snapshot"),
  buildTier(34, "800000000", "0.5", "0.7813", "1.28", "146382000", "bybit-api-snapshot"),
  buildTier(35, "1200000000", "0.6", "1", "1.00", "226382000", "bybit-api-snapshot"),
];

/**
 * Same provenance and transcription convention as BTCUSDT_TIERS above, for
 * `symbol=ADAUSDT`, captured from the same 2026-08-05 snapshot. Included
 * alongside BTCUSDT specifically because it is a much smaller-notional ladder
 * (30 tiers spanning 200K-35M USDT vs BTC's 2M-1.2B) — a useful second real
 * data point for testing tier-lookup boundaries without extrapolating from
 * BTC alone.
 */
const ADAUSDT_TIERS: readonly MarginTier[] = [
  buildTier(1, "200000", "0.0075", "0.0133", "75.00", "0", "bybit-api-snapshot"),
  buildTier(2, "300000", "0.01", "0.02", "50.00", "500", "bybit-api-snapshot"),
  buildTier(3, "500000", "0.015", "0.03", "33.33", "2000", "bybit-api-snapshot"),
  buildTier(4, "900000", "0.02", "0.04", "25.00", "4500", "bybit-api-snapshot"),
  buildTier(5, "1300000", "0.025", "0.05", "20.00", "9000", "bybit-api-snapshot"),
  buildTier(6, "1700000", "0.03", "0.06", "16.67", "15500", "bybit-api-snapshot"),
  buildTier(7, "2100000", "0.035", "0.07", "14.29", "24000", "bybit-api-snapshot"),
  buildTier(8, "2500000", "0.04", "0.08", "12.50", "34500", "bybit-api-snapshot"),
  buildTier(9, "2900000", "0.045", "0.09", "11.11", "47000", "bybit-api-snapshot"),
  buildTier(10, "3300000", "0.05", "0.1", "10.00", "61500", "bybit-api-snapshot"),
  buildTier(11, "3700000", "0.055", "0.11", "9.09", "78000", "bybit-api-snapshot"),
  buildTier(12, "4100000", "0.06", "0.12", "8.33", "96500", "bybit-api-snapshot"),
  buildTier(13, "4500000", "0.065", "0.13", "7.69", "117000", "bybit-api-snapshot"),
  buildTier(14, "4900000", "0.07", "0.14", "7.14", "139500", "bybit-api-snapshot"),
  buildTier(15, "5000000", "0.075", "0.15", "6.67", "164000", "bybit-api-snapshot"),
  buildTier(16, "7000000", "0.08", "0.16", "6.25", "189000", "bybit-api-snapshot"),
  buildTier(17, "9000000", "0.085", "0.17", "5.88", "224000", "bybit-api-snapshot"),
  buildTier(18, "11000000", "0.09", "0.18", "5.56", "269000", "bybit-api-snapshot"),
  buildTier(19, "13000000", "0.095", "0.19", "5.26", "324000", "bybit-api-snapshot"),
  buildTier(20, "15000000", "0.1", "0.2", "5.00", "389000", "bybit-api-snapshot"),
  buildTier(21, "17000000", "0.105", "0.21", "4.76", "464000", "bybit-api-snapshot"),
  buildTier(22, "19000000", "0.11", "0.22", "4.55", "549000", "bybit-api-snapshot"),
  buildTier(23, "21000000", "0.115", "0.23", "4.35", "644000", "bybit-api-snapshot"),
  buildTier(24, "23000000", "0.12", "0.24", "4.17", "749000", "bybit-api-snapshot"),
  buildTier(25, "25000000", "0.125", "0.25", "4.00", "864000", "bybit-api-snapshot"),
  buildTier(26, "27000000", "0.13", "0.26", "3.85", "989000", "bybit-api-snapshot"),
  buildTier(27, "29000000", "0.135", "0.27", "3.70", "1124000", "bybit-api-snapshot"),
  buildTier(28, "31000000", "0.2", "0.4", "2.50", "3009000", "bybit-api-snapshot"),
  buildTier(29, "33000000", "0.4", "0.7", "1.43", "9209000", "bybit-api-snapshot"),
  buildTier(30, "35000000", "0.6", "1", "1.00", "15809000", "bybit-api-snapshot"),
];

/**
 * Decimal-string mirror of `MarginTier` — the shape each row of
 * `marginTierData.json` is written in (see `MarginTierJson` in
 * `src/scripts/fetchMarginTierData.ts`, which this type is kept in exact sync
 * with by hand; it is not re-imported from that script to avoid a src/
 * script -> src/emulation dependency edge for what is otherwise a one-off,
 * manually-run tool). Every field is exactly what `buildTier` expects as a
 * string argument.
 */
interface MarginTierJsonRow {
  tier: number;
  riskLimitValue: string;
  maintenanceMarginRate: string;
  initialMarginRate: string;
  maxLeverage: string;
  mmDeduction: string;
  source: MarginTierSource;
}

/** See `process.cwd()` note on `FETCHED_MARGIN_TIERS`'s own doc comment for why this is resolved from cwd rather than `import.meta.url`. */
const MARGIN_TIER_DATA_PATH = path.resolve(process.cwd(), "src/emulation/marginTierData.json");

/**
 * Reads and parses `marginTierData.json` once at module load, converting
 * every row's decimal-string fields to `Big` via `buildTier` (same conversion
 * `KNOWN_MARGIN_TIERS`'s own hardcoded tables go through). Not wrapped in a
 * try/catch: this file is checked into the repo alongside this module (see
 * this module's top-level doc comment, source 8) and is expected to always be
 * present — a missing/corrupt file is a real environment problem that should
 * fail loudly at import time, not be silently swallowed into an empty table
 * (PROJECT.md ТАБУ #10, "ни одного проглоченного исключения" — the same
 * no-silent-fallback stance `simulateForcedLiquidation`'s unsorted-ticks check
 * takes elsewhere in this module).
 */
function loadFetchedMarginTiers(): MarginTierTable {
  const raw = readFileSync(MARGIN_TIER_DATA_PATH, "utf8");
  const parsed = JSON.parse(raw) as Record<string, readonly MarginTierJsonRow[]>;

  const table: Record<string, readonly MarginTier[]> = {};
  for (const [symbol, rows] of Object.entries(parsed)) {
    table[symbol] = rows.map((row) =>
      buildTier(
        row.tier,
        row.riskLimitValue,
        row.maintenanceMarginRate,
        row.initialMarginRate,
        row.maxLeverage,
        row.mmDeduction,
        row.source,
      ),
    );
  }
  return table;
}

/**
 * Symbols hand-transcribed and independently cross-checked against Bybit's
 * own published worked examples (see this module's top-level doc comment,
 * sources 4/7) — the two highest-confidence entries in the tier system, kept
 * deliberately small and manually reviewed rather than folded into the
 * larger, script-generated `FETCHED_MARGIN_TIERS` below. `lookupMarginTier`
 * checks this table FIRST, so these two symbols' rows always win even though
 * `FETCHED_MARGIN_TIERS` also (redundantly, and verified byte-for-byte
 * identical) carries BTCUSDT/ADAUSDT — see that table's own doc comment.
 */
export const KNOWN_MARGIN_TIERS: MarginTierTable = {
  BTCUSDT: BTCUSDT_TIERS,
  ADAUSDT: ADAUSDT_TIERS,
};

/**
 * Full-universe margin-tier data loaded from `src/emulation/marginTierData.json`
 * (this module's top-level doc comment, source 8) — every symbol
 * `src/scripts/fetchMarginTierData.ts` was able to fetch from Bybit's live
 * `GET /v5/market/risk-limit` endpoint, 293 symbols as of the 2026-08-05/06
 * snapshot, keyed exactly like `KNOWN_MARGIN_TIERS`. Read synchronously at
 * module load (this is a small, static, checked-in data file, not a runtime
 * fetch — same "load once at import time" convention as this file's own
 * hardcoded tier tables, just sourced from JSON instead of literal
 * `buildTier` calls).
 *
 * The JSON path is resolved from `process.cwd()`, matching
 * `fetchMarginTierData.ts`'s own `OUTPUT_PATH` convention (that script is
 * documented to run from the repo root) — NOT from `import.meta.url`,
 * because after a `tsc` build this module's compiled location moves under
 * `dist/emulation/` while the data file stays at `src/emulation/`; resolving
 * from `process.cwd()` finds it either way as long as the process is started
 * from the repo root (true for `vitest`, `npm run build`-then-`node dist/...`,
 * and this repo's other scripts alike).
 *
 * `lookupMarginTier` consults this table only for symbols `KNOWN_MARGIN_TIERS`
 * (or the caller's own `table` argument) doesn't itself have — see that
 * function's own doc comment for the full fallback order.
 */
export const FETCHED_MARGIN_TIERS: MarginTierTable = loadFetchedMarginTiers();

/**
 * Used by `lookupMarginTier` for any symbol not in KNOWN_MARGIN_TIERS or
 * FETCHED_MARGIN_TIERS. This is NOT observed Bybit data for any real symbol —
 * see MarginTier.source's own doc comment for why that matters and what a
 * caller should do about it.
 *
 * Deliberately worse (higher MMR/IMR, therefore a liquidation price closer to
 * entry — less runway) than BOTH real tier-1 samples this file has verified:
 * BTCUSDT's 0.5%/1% and ADAUSDT's 0.75%/1.33%. PARAMS-CONSERVATIVE.md §4's
 * liquidity floor (min 100M USDT perp turnover / 20M spot turnover) and its
 * Innovation/Adventure Zone exclusion mean any symbol this bot actually
 * considers is a liquid, established market — closer in kind to BTCUSDT/
 * ADAUSDT than to a thin small-cap (a real small-cap tier-1 MMR observed in
 * the same snapshot run, ESPORTSUSDT, was 5% — five times higher again than
 * this placeholder). This value is chosen to sit clearly above every real
 * liquid symbol sampled, so an unverified symbol's ESTIMATED liquidation
 * price is never reported as safer (further from entry) than a verified
 * symbol's real one would be — "лучше закрыться зря" (PROJECT.md §6) applies
 * to an estimate too. `mmDeduction: 0` is likewise the conservative choice:
 * omitting a real tier's positive deduction only ever INCREASES the computed
 * Maintenance Margin for a given notional (see `computeMaintenanceMargin`),
 * never decreases it.
 */
export const FALLBACK_CONSERVATIVE_TIER: MarginTier = buildTier(
  0,
  "0", // riskLimitValue is unused for a single-tier fallback — lookupMarginTier never consults it.
  "0.02", // MMR = 2%: ~2.7x ADAUSDT's real tier-1 MMR (0.75%), ~4x BTCUSDT's (0.5%).
  "0.04", // IMR = 4%: matches the 2:1 IMR:MMR ratio both real tables show at their own tier 1.
  "25.00",
  "0",
  "conservative-placeholder",
);

/**
 * Selects the risk-limit tier that applies to a given position notional, the
 * same way Bybit itself does — source 4: "the system will automatically
 * adjust the user's risk limit based on ... the position value ...
 * Consequently, the requirements for maintenance margin and initial margin
 * will also change accordingly," with USDT-contract position value defined
 * as `Contract Size × Mark Price` (same source, Notes section) — i.e. the
 * caller passes `qty.times(markPrice)` (or `.times(entryPrice)` for a
 * pre-trade estimate), not qty alone.
 *
 * Looks a symbol up in two layers, in priority order: first `table` (default
 * `KNOWN_MARGIN_TIERS`, the small hand-verified set), then — only if `table`
 * doesn't have that symbol — `FETCHED_MARGIN_TIERS` (the full-universe,
 * script-generated set; see that constant's own doc comment). This means a
 * caller supplying a custom `table` (e.g. this module's own tests) still
 * transparently gets full-universe coverage as a second layer underneath
 * their override, exactly like the default call site does. Falls back to
 * `FALLBACK_CONSERVATIVE_TIER` only when NEITHER layer has the symbol — never
 * throws for an unknown symbol, matching this task's explicit instruction to
 * hardcode a conservative default rather than block on missing per-symbol
 * data. Callers that must not silently trade on a placeholder tier should
 * check the returned tier's `source` field themselves (see MarginTier.source).
 *
 * When `positionNotional` exceeds every bracket in the symbol's own table,
 * clamps to the last (highest-risk) tier rather than throwing or
 * extrapolating a tier that doesn't exist — mirrors Bybit's own real
 * behavior at that point (source 4: "once the effective position value ...
 * reaches the risk limit cap, the system will only accept Reduce Only ...
 * orders," i.e. the position sits at the highest tier it already reached,
 * unable to grow further).
 */
export function lookupMarginTier(
  symbol: string,
  positionNotional: Big,
  table: MarginTierTable = KNOWN_MARGIN_TIERS,
): MarginTier {
  if (positionNotional.lte(0)) {
    throw new RangeError(`positionNotional must be positive, got ${positionNotional.toString()}`);
  }

  const tiers = table[symbol] ?? FETCHED_MARGIN_TIERS[symbol];
  if (tiers === undefined || tiers.length === 0) {
    return FALLBACK_CONSERVATIVE_TIER;
  }

  const matched = tiers.find((t) => positionNotional.lte(t.riskLimitValue));
  return matched ?? tiers[tiers.length - 1]!;
}
