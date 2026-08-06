import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { MarginTierSource } from "../emulation/liquidation.js";
import { PublicExchangeClient } from "../exchange/client.js";
import { RateLimiter } from "../exchange/rateLimiter.js";
import { computeTradeableUniverse } from "../market-data/universe.js";

/**
 * RISK-REGISTER.md FM-38: `emulation/liquidation.ts`'s `lookupMarginTier()`
 * only knows real Bybit margin-tier data for BTCUSDT/ADAUSDT (hand-transcribed
 * into `KNOWN_MARGIN_TIERS`) — every other symbol in the ~293-symbol tradeable
 * universe falls back to `FALLBACK_CONSERVATIVE_TIER`, a placeholder that a
 * live probe (2026-08-06) confirmed is NOT conservative for thin alts
 * (ESPORTSUSDT tier-1 MMR is 5%, 2.5x the fallback's 2%).
 *
 * One-off, manually-run script — same convention as backfillFundingHistory.ts
 * (NOT part of collector.ts's regular schedule). Pulls `GET /v5/market/
 * risk-limit?category=linear&symbol=<SYM>` for every symbol in
 * market-data/universe.ts's tradeable universe and writes the full tier
 * ladder to a JSON data file, NOT TypeScript constants: ~293 symbols x up to
 * 35 tiers each is thousands of lines, unmanageable as hardcode (compare
 * KNOWN_MARGIN_TIERS's two symbols already spanning ~180 lines in
 * liquidation.ts). JSON keeps the data reviewable in a diff and trivially
 * re-fetchable by re-running this script, without bloating the module that
 * actually consumes it.
 *
 * Output shape is `{ [symbol]: MarginTierJson[] }`, `MarginTierJson` a
 * field-for-field mirror of liquidation.ts's own `MarginTier` interface
 * (`tier`, `riskLimitValue`, `maintenanceMarginRate`, `initialMarginRate`,
 * `maxLeverage`, `mmDeduction`, `source`) with the `Big`-valued fields as
 * plain decimal strings — a JSON file can't carry `Big` instances, and every
 * one of those fields is exactly what `Big.js`'s own constructor accepts, so
 * wiring this into `KNOWN_MARGIN_TIERS`-equivalent runtime data later is a
 * straight `new Big(row.field)` per field, no reparsing/renaming. `source` is
 * always `"bybit-api-snapshot"` here (imported as a type only from
 * liquidation.ts, so this file's literal can never silently drift from that
 * module's own union) — this script has no notion of a placeholder.
 *
 * Run once via: npm run build && node dist/scripts/fetchMarginTierData.js
 * (no .env / DATABASE_URL needed — this script never touches storage/, it
 * only calls Bybit's public, unauthenticated risk-limit endpoint and writes
 * a file). Safe to re-run: it always overwrites the full output file with a
 * fresh snapshot rather than merging, so a re-run can't leave stale tiers
 * mixed with new ones from a different capture date.
 */

const CALL_SPACING_MS = 180; // NFR-04 spacing convention (backfillFundingHistory.ts: 150ms; kept slightly wider here since this is a single unattended full-universe sweep, not a scheduled collector run)
const OUTPUT_PATH = path.resolve(process.cwd(), "src/emulation/marginTierData.json");

/**
 * Field-for-field mirror of `emulation/liquidation.ts`'s `MarginTier`, with
 * the `Big`-valued fields as decimal strings (see module doc comment above).
 */
interface MarginTierJson {
  tier: number;
  riskLimitValue: string;
  maintenanceMarginRate: string;
  initialMarginRate: string;
  maxLeverage: string;
  mmDeduction: string;
  source: MarginTierSource;
}

interface FailedSymbol {
  symbol: string;
  reason: string;
}

/**
 * Fetches one symbol's full risk-limit tier ladder, following `nextPageCursor`
 * defensively (a live capture of BTCUSDT/ESPORTSUSDT/ADAUSDT during
 * development always returned every tier — 35/30/30 respectively — in a
 * single page with `nextPageCursor: ""`; per-symbol queries appear to never
 * actually paginate in practice, only a symbol-less category-wide query
 * would). Every HTTP call, including a hypothetical follow-up page, is routed
 * through `limiter` individually — never two calls per symbol issued back to
 * back — matching rateLimiter.ts's own "no burst, ever" contract.
 *
 * `response.result`'s bybit-api-declared type (`CategoryListV5<RiskLimitV5[],
 * 'linear'>` = `{category, list}`) omits `nextPageCursor`, but the raw wire
 * response DOES carry one at that level (verified via a live, unfiltered
 * curl against api.bybit.com on 2026-08-06) — the same SDK type-vs-wire drift
 * RISK-REGISTER.md FM-24 documents generally (bybit-api #512/#516). The cast
 * below is a widening one only (every field it reads is optional on the
 * target type), not a narrowing lie.
 */
/** Intermediate row shape before `tier` (a per-symbol rank) is computed — see `fetchTiersForSymbol`'s own doc comment for why that can't come from the wire directly. */
type UntieredRow = Omit<MarginTierJson, "tier">;

async function fetchTiersForSymbol(
  client: PublicExchangeClient,
  limiter: RateLimiter,
  symbol: string,
): Promise<MarginTierJson[]> {
  const rows: UntieredRow[] = [];
  let cursor: string | undefined;

  do {
    const response = await limiter.schedule(() =>
      client.getRiskLimit({
        category: "linear",
        symbol,
        ...(cursor ? { cursor } : {}),
      }),
    );

    for (const item of response.result.list) {
      rows.push({
        riskLimitValue: item.riskLimitValue,
        // bybit-api's .d.ts claims `maintenanceMargin`/`initialMargin` are
        // `number`; the live wire response returns them as decimal STRINGS
        // (e.g. "0.005", not 0.005) — verified the same way as the
        // nextPageCursor drift noted above. `String(...)` is a no-op on an
        // already-string runtime value and correctly stringifies in the
        // (currently unobserved) case the field really were numeric.
        maintenanceMarginRate: String(item.maintenanceMargin),
        initialMarginRate: String(item.initialMargin),
        maxLeverage: item.maxLeverage,
        // Bybit returns `""` for tier 1's mmDeduction (nothing below it to
        // correct for) — normalized to "0" here so every row is directly
        // `new Big(...)`-able without a caller-side special case, matching
        // liquidation.ts's own BTCUSDT_TIERS/ADAUSDT_TIERS transcription
        // convention (see that file's buildTier calls for tier 1).
        mmDeduction: item.mmDeduction === "" ? "0" : item.mmDeduction,
        source: "bybit-api-snapshot",
      });
    }

    cursor = (response.result as { nextPageCursor?: string }).nextPageCursor || undefined;
  } while (cursor);

  // Bybit's raw `id` field is a GLOBAL running counter across every symbol's
  // rows in the entire risk-limit table, NOT a per-symbol tier rank — caught
  // by live verification (2026-08-06): ADAUSDT's own lowest-risk row
  // (isLowestRisk=1) carries id=116, not 1. It only LOOKED like a 1-based
  // per-symbol rank for BTCUSDT, whose rows happen to occupy global ids 1-35.
  // This module's own `MarginTier.tier` doc comment defines the field as
  // "1-based rank within the symbol's ladder, ascending risk" — computed
  // here by sorting on the NUMERIC riskLimitValue (a naive string sort would
  // order "9000000" before "35000000") rather than trusting any id off the
  // wire, matching liquidation.ts's own BTCUSDT_TIERS/ADAUSDT_TIERS numbering
  // (tier 1..N, not id 1..35 / 116..145).
  rows.sort((a, b) => Number(a.riskLimitValue) - Number(b.riskLimitValue));

  return rows.map((row, i) => ({ tier: i + 1, ...row }));
}

async function main(): Promise<void> {
  const client = new PublicExchangeClient({ testnet: false });
  const limiter = new RateLimiter(CALL_SPACING_MS);

  console.log("[fetch-margin-tiers] computing tradeable universe...");
  const universe = await computeTradeableUniverse(client);
  console.log(`[fetch-margin-tiers] ${String(universe.length)} symbols in universe`);

  const data: Record<string, MarginTierJson[]> = {};
  const failed: FailedSymbol[] = [];
  let done = 0;

  for (const { symbol } of universe) {
    try {
      const tiers = await fetchTiersForSymbol(client, limiter, symbol);
      if (tiers.length === 0) {
        // Retcode 0 with an empty list is distinct from a thrown error (e.g.
        // a delisted/invalid symbol, which Bybit answers with retCode 10001
        // and is caught below) — still recorded as failed since there is
        // nothing usable to write for this symbol either way.
        failed.push({ symbol, reason: "empty tier list (retCode 0, zero rows)" });
      } else {
        data[symbol] = tiers;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed.push({ symbol, reason });
      console.error(`[fetch-margin-tiers] ${symbol} failed: ${reason}`);
    }

    done++;
    if (done % 25 === 0 || done === universe.length) {
      console.log(`[fetch-margin-tiers] progress: ${String(done)}/${String(universe.length)}`);
    }
  }

  await writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  const coveredCount = Object.keys(data).length;
  console.log(`\n[fetch-margin-tiers] wrote ${String(coveredCount)} symbols to ${OUTPUT_PATH}`);
  console.log(
    `[fetch-margin-tiers] coverage: ${String(coveredCount)}/${String(universe.length)} (${(
      (coveredCount / universe.length) *
      100
    ).toFixed(1)}%)`,
  );
  if (failed.length > 0) {
    console.log(`[fetch-margin-tiers] ${String(failed.length)} symbols failed:`);
    for (const f of failed) {
      console.log(`  ${f.symbol}: ${f.reason}`);
    }
  }
}

main().catch((e) => {
  console.error("[fetch-margin-tiers] fatal:", e);
  process.exit(1);
});
