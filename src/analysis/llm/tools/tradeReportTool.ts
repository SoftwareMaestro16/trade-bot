import Big from "big.js";
import { NarratingTool, RUSSIAN_ANALYST_SYSTEM_PROMPT } from "./analysisTool.js";
import type { LlmClient, LlmPrompt } from "../client.js";

/**
 * Уже посчитанная разбивка результата прогона — приходит от вызывающего
 * (reportGenerator знает точный P&L), инструмент её НЕ пересчитывает. Все
 * денежные величины — Big, издержки со своим знаком, как в
 * execution/realizedPnl.ts.
 */
export interface TradeReportInput {
  runId: string;
  startingDeposit: Big;
  endingEquity: Big;
  tradeCount: number;
  winCount: number;
  fundingIncome: Big;
  basisPnl: Big;
  fees: Big;
  slippage: Big;
  borrowCost: Big;
  /** Разбивка по причинам выхода — необязательна. */
  exitBreakdown?: { reason: string; count: number }[];
}

/**
 * Производные факты — детерминированный вывод из входа. То, что модель обязана
 * лишь пересказать, а не вычислить.
 */
export interface TradeReportFacts {
  netPnl: Big;
  returnPct: Big;
  winRatePct: Big;
  /** Компонент с наибольшим отрицательным вкладом — «куда ушли деньги». */
  dominantLossDriver: string;
  /** Доля издержек (комиссии+проскальзывание+заём) в модуле net P&L, %. */
  costShareOfPnlPct: Big | null;
}

const COST_LABELS: Record<string, string> = {
  fees: "комиссии",
  slippage: "проскальзывание",
  borrowCost: "стоимость займа",
  basisPnl: "движение базиса",
};

/**
 * Инструмент разбора отчёта: детерминированно считает нетто, доходность,
 * win-rate и главный источник убытка, затем просит LLM пересказать это простым
 * языком. Ни одной цифры сверх переданных.
 */
export class TradeReportTool extends NarratingTool<TradeReportInput, TradeReportFacts> {
  readonly name = "trade_report_analysis";
  readonly description =
    "Разбирает результат прогона: на чём заработали/потеряли, какой компонент съел деньги, простыми словами.";

  constructor(llm: LlmClient) {
    super(llm);
  }

  protected computeData(input: TradeReportInput): TradeReportFacts {
    const netPnl = input.endingEquity.minus(input.startingDeposit);
    const returnPct = input.startingDeposit.gt(0)
      ? netPnl.div(input.startingDeposit).times(100)
      : new Big(0);
    const winRatePct =
      input.tradeCount > 0 ? new Big(input.winCount).div(input.tradeCount).times(100) : new Big(0);

    // Самый отрицательный вклад среди компонентов. basisPnl двузнаковый —
    // учитывается только когда он в минусе.
    const components: { key: string; value: Big }[] = [
      { key: "fees", value: input.fees },
      { key: "slippage", value: input.slippage },
      { key: "borrowCost", value: input.borrowCost },
      { key: "basisPnl", value: input.basisPnl },
    ];
    const worst = components.reduce((a, b) => (b.value.lt(a.value) ? b : a));
    const dominantLossDriver = worst.value.lt(0) ? (COST_LABELS[worst.key] ?? worst.key) : "нет убыточного компонента";

    const totalCosts = input.fees.plus(input.slippage).plus(input.borrowCost).abs();
    const costShareOfPnlPct = netPnl.eq(0) ? null : totalCosts.div(netPnl.abs()).times(100);

    return { netPnl, returnPct, winRatePct, dominantLossDriver, costShareOfPnlPct };
  }

  protected buildPrompt(data: TradeReportFacts, input: TradeReportInput): LlmPrompt {
    return {
      system: RUSSIAN_ANALYST_SYSTEM_PROMPT,
      user:
        "Кратко опиши результат этого прогона бота простыми словами: на чём заработали или потеряли " +
        "и что это значит.\n\n" +
        formatReportFacts(data, input),
    };
  }
}

export function formatReportFacts(data: TradeReportFacts, input: TradeReportInput): string {
  const lines: string[] = [
    `Прогон: ${input.runId}.`,
    `Депозит: $${input.startingDeposit.toFixed(2)} -> $${input.endingEquity.toFixed(2)} ` +
      `(${data.netPnl.gte(0) ? "+" : ""}$${data.netPnl.toFixed(2)} / ${data.returnPct.toFixed(2)}%).`,
    `Сделок: ${String(input.tradeCount)}, из них прибыльных ${String(input.winCount)} ` +
      `(win-rate ${data.winRatePct.toFixed(1)}%).`,
    `Funding: +$${input.fundingIncome.toFixed(2)}. Базис: $${input.basisPnl.toFixed(2)}. ` +
      `Комиссии: $${input.fees.toFixed(2)}. Проскальзывание: $${input.slippage.toFixed(2)}. ` +
      `Заём: $${input.borrowCost.toFixed(2)}.`,
    `Главный источник убытка: ${data.dominantLossDriver}.`,
  ];
  if (data.costShareOfPnlPct !== null) {
    lines.push(`Издержки составили ${data.costShareOfPnlPct.toFixed(0)}% от модуля итогового P&L.`);
  }
  if (input.exitBreakdown && input.exitBreakdown.length > 0) {
    const parts = input.exitBreakdown.map((e) => `${e.reason}: ${String(e.count)}`).join(", ");
    lines.push(`Причины выхода: ${parts}.`);
  }
  return lines.join("\n");
}
