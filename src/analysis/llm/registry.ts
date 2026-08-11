import type { AnalysisTool } from "./tools/analysisTool.js";
import type { LlmClient } from "./client.js";
import { MarketAssessmentTool } from "./tools/marketAssessmentTool.js";
import { TradeReportTool } from "./tools/tradeReportTool.js";
import { OpportunityOutlookTool } from "./tools/opportunityOutlookTool.js";

/**
 * Каталог инструментов по имени. Существует ради Open/Closed: код, который
 * «перечислить инструменты» или «дать манифест для LLM-function-calling»,
 * работает через реестр и не меняется при добавлении нового инструмента.
 *
 * Namespace-типы стёрты до `unknown` внутри — у инструментов разные входы/
 * выходы, единый Map иначе типизировать нельзя. Для реального вызова берут
 * конкретный инструмент (типобезопасно), реестр — для обзора и диспетчеризации
 * по имени.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnalysisTool<unknown, unknown>>();

  register(tool: AnalysisTool<unknown, unknown>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: инструмент "${tool.name}" уже зарегистрирован`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnalysisTool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  /** Манифест: имя + описание каждого инструмента — то, что можно показать LLM или пользователю. */
  manifest(): { name: string; description: string }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description }));
  }
}

/**
 * Собранный набор инструментов с типобезопасным доступом к каждому. Фабрика —
 * единственное место, где конкретные классы соединяются с клиентом (Dependency
 * Inversion на границе композиции): всё остальное принимает уже готовые
 * инструменты или их интерфейс.
 */
export interface Toolset {
  marketAssessment: MarketAssessmentTool;
  tradeReport: TradeReportTool;
  opportunityOutlook: OpportunityOutlookTool;
  registry: ToolRegistry;
}

export function buildToolset(llm: LlmClient): Toolset {
  const marketAssessment = new MarketAssessmentTool(llm);
  const tradeReport = new TradeReportTool(llm);
  const opportunityOutlook = new OpportunityOutlookTool(llm);

  const registry = new ToolRegistry()
    .register(marketAssessment)
    .register(tradeReport)
    .register(opportunityOutlook);

  return { marketAssessment, tradeReport, opportunityOutlook, registry };
}
