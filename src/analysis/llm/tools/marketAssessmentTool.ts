import { assessMarket } from "../../marketAssessment.js";
import type { MarketAssessment, SymbolMarketStat } from "../../marketAssessment.js";
import { NarratingTool, RUSSIAN_ANALYST_SYSTEM_PROMPT } from "./analysisTool.js";
import type { LlmClient, LlmPrompt } from "../client.js";

export interface MarketAssessmentInput {
  stats: readonly SymbolMarketStat[];
  /** Необязательный контекст (например, свежие листинги/делистинги) — вплетается в промпт как есть. */
  extraContext?: string;
}

/**
 * Инструмент оценки рынка: детерминированный `assessMarket` считает, что
 * пригодно к торговле прямо сейчас, а LLM переформулирует итог человеку.
 * Вычислительная часть — целиком чужая (marketAssessment.ts), инструмент лишь
 * связывает её с моделью и строит промпт (Single Responsibility).
 */
export class MarketAssessmentTool extends NarratingTool<MarketAssessmentInput, MarketAssessment> {
  readonly name = "market_assessment";
  readonly description =
    "Оценивает пригодность рынка для запуска стратегии (0-100) и перечисляет пары, проходящие все три условия входа.";

  constructor(llm: LlmClient) {
    super(llm);
  }

  protected computeData(input: MarketAssessmentInput): MarketAssessment {
    return assessMarket(input.stats);
  }

  protected buildPrompt(data: MarketAssessment, input: MarketAssessmentInput): LlmPrompt {
    return {
      system: RUSSIAN_ANALYST_SYSTEM_PROMPT,
      user:
        "Опиши текущее состояние рынка для funding-arbitrage стратегии по этим данным. " +
        "Простыми словами объясни, стоит ли сейчас запускать бота и почему.\n\n" +
        formatAssessmentFacts(data) +
        appendContext(input.extraContext),
    };
  }
}

/**
 * Детерминированный «факт-блок», который модель обязана лишь переформулировать.
 * Экспортирован, чтобы точный текст (и, значит, чему модель НЕ даёт выдумывать)
 * покрывался юнит-тестом — арифметика тут, у модели только слова.
 */
export function formatAssessmentFacts(a: MarketAssessment): string {
  const lines: string[] = [
    `Просканировано пар: ${String(a.scannedSymbols)}.`,
    `Оценка пригодности рынка: ${String(a.suitabilityScore)}/100 (${a.suitability}).`,
    `Пар, проходящих ВСЕ три условия (ликвидность + funding + стабильность базиса): ${String(a.opportunities.length)}.`,
    `Пар ликвидных с funding, но со слишком волатильным базисом: ${String(a.fundedButVolatile)}.`,
    `Пар ликвидных, но с funding ниже порога: ${String(a.liquidButUnfunded)}.`,
  ];
  if (a.opportunities.length > 0) {
    lines.push("Возможности (лучшие по funding):");
    for (const o of a.opportunities.slice(0, 5)) {
      const r8hPct = o.predictedR8h.times(100).toFixed(3);
      const sigmas = o.sigmasToStop !== null ? o.sigmasToStop.toFixed(1) : "н/д";
      lines.push(
        `  - ${o.symbol}: funding ${r8hPct}%/8ч, запас до стопа ${sigmas} сигм, ` +
          `потолок дохода ${o.grossMonthlyCeilingPct.toFixed(2)}%/мес (идеализированный).`,
      );
    }
  }
  return lines.join("\n");
}

function appendContext(extraContext?: string): string {
  return extraContext && extraContext.trim().length > 0
    ? `\n\nДополнительный контекст:\n${extraContext}`
    : "";
}
