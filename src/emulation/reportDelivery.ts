import Big from "big.js";
import type { GenerateReportsResult } from "./reportGenerator.js";
import { computeTradeReportFacts } from "../analysis/llm/tools/tradeReportTool.js";
import type { TradeReportInput } from "../analysis/llm/tools/tradeReportTool.js";
import type { Toolset } from "../analysis/llm/index.js";

/**
 * Сборка и подпись отчёта эмуляции для Telegram. Владелец: «отчёт одним файлом,
 * а не тремя; текст-подпись к нему; и в первую очередь — резюме от LLM, а если
 * не удалось сформулировать — то же сделает скрипт».
 *
 * Соответственно здесь две вещи, обе чистые и тестируемые:
 *  - buildCombinedReport: три артефакта (summary.md + trades.csv + equity.csv)
 *    в ОДИН markdown-файл.
 *  - resolveReportCaption: подпись. Сначала пробует LLM-инструмент разбора
 *    отчёта; если LLM недоступен/сбоил (narrative === null) — детерминированная
 *    подпись из тех же чисел. Порядок ровно как просил владелец.
 */

export function buildCombinedReport(runId: string, reports: GenerateReportsResult): { filename: string; content: string } {
  const content = [
    reports.summaryMarkdown.trimEnd(),
    "\n\n---\n\n## Сделки\n\n```csv\n" + reports.tradesCsv.trim() + "\n```",
    "\n\n---\n\n## Кривая эквити\n\n```csv\n" + reports.equityCurveCsv.trim() + "\n```\n",
  ].join("");
  return { filename: `paper_report_${runId}.md`, content };
}

/** Детерминированная подпись-фолбэк из чисел отчёта — когда LLM недоступен. */
export function buildDeterministicCaption(input: TradeReportInput): string {
  const f = computeTradeReportFacts(input);
  // Знак ПЕРЕД $, а не внутри числа: "-$4.91", не "$-4.91".
  const usd = (v: Big): string => `${v.gte(0) ? "+" : "-"}$${v.abs().toFixed(2)}`;
  const pct = (v: Big): string => `${v.gte(0) ? "+" : "-"}${v.abs().toFixed(2)}%`;
  const costs = input.fees.plus(input.slippage).plus(input.borrowCost);
  const lines = [
    `📊 Эмуляция "${input.runId}"`,
    `Депозит: $${input.startingDeposit.toFixed(2)} -> $${input.endingEquity.toFixed(2)} ` +
      `(${usd(f.netPnl)} / ${pct(f.returnPct)})`,
    `Сделок: ${String(input.tradeCount)}, прибыльных ${String(input.winCount)} (win-rate ${f.winRatePct.toFixed(1)}%)`,
    `Funding ${usd(input.fundingIncome)}, базис ${usd(input.basisPnl)}, издержки ${usd(costs)}`,
  ];
  if (input.tradeCount > 0) {
    lines.push(`Главный источник убытка: ${f.dominantLossDriver}`);
  }
  lines.push("Подробности по каждой сделке — в приложенном файле.");
  return lines.join("\n");
}

export interface ResolvedCaption {
  caption: string;
  source: "llm" | "script";
}

/**
 * Подпись LLM-first: пробует резюме от инструмента, при недоступности/сбое
 * (нет toolset, либо narrative === null) — детерминированная подпись скрипта.
 * Инструмент сам не бросает (NarratingTool глотает LlmError в narrative=null),
 * так что здесь не нужен try/catch — но toolset может отсутствовать (нет ключа).
 */
export async function resolveReportCaption(
  input: TradeReportInput,
  toolset: Toolset | null,
): Promise<ResolvedCaption> {
  if (toolset) {
    const result = await toolset.tradeReport.run(input);
    if (result.narrative !== null && result.narrative.trim().length > 0) {
      return { caption: result.narrative, source: "llm" };
    }
  }
  return { caption: buildDeterministicCaption(input), source: "script" };
}
