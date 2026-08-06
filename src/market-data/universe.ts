import type { PublicExchangeClient } from "../exchange/client.js";

export interface UniverseSymbol {
  symbol: string;
  fundingIntervalMinutes: number;
}

/**
 * FR-108: только пересечение спот × перп хранится — сбор данных по перпу без
 * торгуемой спотовой пары бессмысленен для дельта-нейтральной стратегии.
 *
 * Namespacing правило намеренно консервативное для Фазы 1: пересечение — точное
 * совпадение строки символа (BTCUSDT перп == BTCUSDT спот). Это исключает
 * множительные перпы (1000PEPEUSDT и т.п.), чей спот-контрагент живёт под другим
 * тикером (PEPEUSDT) — RISK-REGISTER.md FM-14. Такое сопоставление специально
 * НЕ строится здесь: это RSK-01/RSK-13, ручная курируемая таблица
 * `symbol_pairs(perp_symbol, spot_symbol, contract_multiplier)`, нужная только
 * когда strategy/execution начнут по этим символам реально торговать (Фаза 2+).
 * Для сбора рыночных данных недооценить юниверс безопасно; переоценить — нет.
 */
export async function computeTradeableUniverse(
  client: PublicExchangeClient,
): Promise<UniverseSymbol[]> {
  const [linearSymbols, spotSymbols] = await Promise.all([
    fetchTradeableLinearPerpetuals(client),
    fetchTradeableSpotSymbols(client),
  ]);

  const universe = linearSymbols.filter((s) => spotSymbols.has(s.symbol));
  universe.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return universe;
}

async function fetchTradeableLinearPerpetuals(
  client: PublicExchangeClient,
): Promise<UniverseSymbol[]> {
  const result: UniverseSymbol[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.getInstrumentsInfo({
      category: "linear",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    for (const instrument of response.result.list) {
      // FM-14: LinearFutures (real deliveryTime) do not pay funding — the funding
      // model would return garbage for them. contractType is the reliable filter,
      // not `category` (which lumps LinearPerpetual and LinearFutures together).
      if (
        instrument.contractType === "LinearPerpetual" &&
        instrument.status === "Trading" &&
        instrument.quoteCoin === "USDT"
      ) {
        result.push({
          symbol: instrument.symbol,
          fundingIntervalMinutes: instrument.fundingInterval,
        });
      }
    }

    cursor = response.result.nextPageCursor || undefined;
  } while (cursor);

  return result;
}

async function fetchTradeableSpotSymbols(client: PublicExchangeClient): Promise<Set<string>> {
  const result = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await client.getInstrumentsInfo({
      category: "spot",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    for (const instrument of response.result.list) {
      if (instrument.status === "Trading" && instrument.quoteCoin === "USDT") {
        result.add(instrument.symbol);
      }
    }

    cursor = response.result.nextPageCursor || undefined;
  } while (cursor);

  return result;
}
