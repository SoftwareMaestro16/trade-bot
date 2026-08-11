/**
 * Barrel модуля LLM-аннотаций. Единая точка импорта для остального кода:
 * клиент, инструменты, реестр. Публичный API держим здесь, чтобы внутренняя
 * раскладка файлов могла меняться без правок у потребителей.
 */
export { OpenRouterClient, LlmError, LLM_ENDPOINT, DEFAULT_LLM_MODEL } from "./client.js";
export type { LlmClient, LlmPrompt, OpenRouterConfig } from "./client.js";

export { NarratingTool, RUSSIAN_ANALYST_SYSTEM_PROMPT } from "./tools/analysisTool.js";
export type { AnalysisTool, Narrated } from "./tools/analysisTool.js";

export { MarketAssessmentTool, formatAssessmentFacts } from "./tools/marketAssessmentTool.js";
export type { MarketAssessmentInput } from "./tools/marketAssessmentTool.js";

export { TradeReportTool, formatReportFacts } from "./tools/tradeReportTool.js";
export type { TradeReportInput, TradeReportFacts } from "./tools/tradeReportTool.js";

export { OpportunityOutlookTool, computeOutlook, formatOutlookFacts } from "./tools/opportunityOutlookTool.js";
export type { OpportunityOutlook, Blocker } from "./tools/opportunityOutlookTool.js";

export { ToolRegistry, buildToolset } from "./registry.js";
export type { Toolset } from "./registry.js";
