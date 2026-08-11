import Big from "big.js";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import { normalizeFundingRateToR8h } from "../market-data/normalizeFunding.js";
import type { SymbolMarketStat } from "./marketAssessment.js";

/**
 * Собирает срез рынка «сейчас» для оценки пригодности (analysis/
 * marketAssessment.ts) — по каждому символу, у которого есть и perp, и spot:
 * свежие обороты, свежий предсказанный funding, текущий базис и скользящее
 * стандартное отклонение базиса.
 *
 * Три запроса, а не по одному на символ: на ~300 парах поштучный STDDEV был бы
 * сотнями round-trip'ов. Джойн делаем в JS. Всё «свежее» ограничено окном
 * recencyMinutes — коллектор пишет часто, а устаревший тикер для оценки «прямо
 * сейчас» бесполезен.
 *
 * Не покрыто локальными юнит-тестами (как и весь storage-слой — нужен живой
 * Postgres); проверяется на VPS. Вся арифметика классификации живёт в чистом,
 * протестированном assessMarket — здесь только выборка.
 */

export interface GatherMarketStatsOptions {
  /** Свежесть тикеров/funding: строки старше этого игнорируются. */
  recencyMinutes?: number;
  /** Окно для STDDEV базиса. */
  basisLookbackHours?: number;
  /** Минимум точек базиса, иначе σ считается неизвестной (null) — та же осторожность, что в scenarioRunner. */
  minBasisSamples?: number;
}

interface LatestTickerRow {
  symbol: string;
  category: string;
  last_price: string;
  mark_price: string | null;
  turnover_24h: string | null;
}
interface LatestFundingRow {
  symbol: string;
  rate: string;
  interval_minutes: number;
}
interface BasisStatRow {
  symbol: string;
  sd: string | null;
  n: string;
}

export async function gatherMarketStats(
  db: Kysely<Database>,
  options: GatherMarketStatsOptions = {},
): Promise<SymbolMarketStat[]> {
  const recencyMinutes = options.recencyMinutes ?? 15;
  const basisLookbackHours = options.basisLookbackHours ?? 24;
  const minBasisSamples = options.minBasisSamples ?? 30;

  // Свежайший тикер на (symbol, category) в пределах окна свежести.
  const tickers = await sql<LatestTickerRow>`
    SELECT DISTINCT ON (symbol, category) symbol, category, last_price, mark_price, turnover_24h
    FROM tickers
    WHERE fetched_at > now() - make_interval(mins => ${recencyMinutes})
    ORDER BY symbol, category, fetched_at DESC
  `.execute(db);

  // Свежайший предсказанный funding на символ.
  const funding = await sql<LatestFundingRow>`
    SELECT DISTINCT ON (symbol) symbol, rate, interval_minutes
    FROM funding_rates
    WHERE kind = 'predicted' AND fetched_at > now() - make_interval(mins => ${recencyMinutes})
    ORDER BY symbol, fetched_at DESC
  `.execute(db);

  // STDDEV базиса по всем символам разом за окно.
  const basis = await sql<BasisStatRow>`
    SELECT perp.symbol AS symbol,
           STDDEV_SAMP((perp.mark_price - spot.last_price) / spot.last_price)::text AS sd,
           COUNT(*)::text AS n
    FROM tickers perp
    JOIN tickers spot
      ON spot.symbol = perp.symbol
     AND spot.fetched_at = perp.fetched_at
     AND spot.category = 'spot'
    WHERE perp.category = 'linear'
      AND perp.mark_price IS NOT NULL
      AND spot.last_price > 0
      AND perp.fetched_at >= now() - make_interval(hours => ${basisLookbackHours})
    GROUP BY perp.symbol
  `.execute(db);

  const perpBySymbol = new Map<string, LatestTickerRow>();
  const spotBySymbol = new Map<string, LatestTickerRow>();
  for (const row of tickers.rows) {
    if (row.category === "linear") perpBySymbol.set(row.symbol, row);
    else if (row.category === "spot") spotBySymbol.set(row.symbol, row);
  }

  const fundingBySymbol = new Map<string, LatestFundingRow>();
  for (const row of funding.rows) fundingBySymbol.set(row.symbol, row);

  const basisSdBySymbol = new Map<string, Big | null>();
  for (const row of basis.rows) {
    const usable = row.sd !== null && Number(row.n) >= minBasisSamples;
    basisSdBySymbol.set(row.symbol, usable ? new Big(row.sd as string) : null);
  }

  const stats: SymbolMarketStat[] = [];
  for (const [symbol, perp] of perpBySymbol) {
    const spot = spotBySymbol.get(symbol);
    const fund = fundingBySymbol.get(symbol);
    // Символ учитываем, только если есть обе ноги и предсказанный funding —
    // без любого из трёх оценивать нечем (то же пересечение, что в эмуляции).
    if (!spot || !fund || perp.mark_price === null) continue;

    const perpMark = new Big(perp.mark_price);
    const spotLast = new Big(spot.last_price);
    if (spotLast.lte(0)) continue;

    stats.push({
      symbol,
      perpTurnover24h: perp.turnover_24h !== null ? new Big(perp.turnover_24h) : new Big(0),
      spotTurnover24h: spot.turnover_24h !== null ? new Big(spot.turnover_24h) : new Big(0),
      predictedR8h: normalizeFundingRateToR8h(new Big(fund.rate), fund.interval_minutes),
      currentBasis: perpMark.minus(spotLast).div(spotLast),
      basisStdDev: basisSdBySymbol.get(symbol) ?? null,
    });
  }

  stats.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return stats;
}
