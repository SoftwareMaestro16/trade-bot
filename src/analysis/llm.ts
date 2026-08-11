import type { MarketAssessment } from "./marketAssessment.js";

/**
 * Minimal LLM client for ANNOTATION ONLY — plain-language summaries of market
 * state and trade reports. Two hard boundaries, both deliberate:
 *
 *  1. It never participates in a trading decision. risk/ is deterministic and
 *     unit-tested (ARCHITECTURE.md §2); a non-deterministic model in the veto
 *     path could not be tested and would be the one component able to lose money
 *     unpredictably. Every function here consumes an ALREADY-DECIDED assessment
 *     and only rephrases it. The owner floated an LLM "opinion on entries" —
 *     that lives, at most, as an advisory line in a report, never as a gate.
 *
 *  2. It never breaks the pipeline. The summary is a garnish on a report whose
 *     content is already complete and correct; a timeout, a rate-limit, a
 *     malformed response must cost the garnish, not the report. These functions
 *     throw LlmError on any failure and callers wrap them in try/catch, exactly
 *     as notify delivery is isolated from computation elsewhere.
 *
 * Bare `fetch` against OpenRouter's OpenAI-compatible endpoint rather than
 * @openrouter/sdk or LangChain: this module makes one HTTP call and parses one
 * field, which does not justify a framework dependency — the same reasoning
 * notify/telegram.ts documents for not pulling in grammY. The model is fed exact
 * numbers and instructed to invent none, the same discipline reportGenerator.ts
 * uses for its trade narratives.
 */

export const LLM_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_LLM_MODEL = "nvidia/nemotron-3.5-lightning:free";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 600;

export interface LlmConfig {
  apiKey: string;
  /** Defaults to DEFAULT_LLM_MODEL. */
  model?: string;
  requestTimeoutMs?: number;
}

/**
 * Carries only the HTTP status and the provider's own error text — never the
 * request, which bears `Authorization: Bearer <key>`. Same redaction discipline
 * as TelegramApiError: no field can hold the key, not even via a stashed raw
 * response object.
 */
export class LlmError extends Error {
  readonly httpStatus: number | undefined;
  readonly providerMessage: string | undefined;

  constructor(message: string, httpStatus?: number, providerMessage?: string) {
    super(message);
    this.name = "LlmError";
    this.httpStatus = httpStatus;
    this.providerMessage = providerMessage;
  }
}

export interface LlmPrompt {
  system: string;
  user: string;
}

const RUSSIAN_SYSTEM_PROMPT =
  "Ты — аналитик, который описывает состояние рынка простым русским языком для владельца торгового " +
  "бота. Строгие правила: (1) используй ТОЛЬКО те числа, что даны во вводных — никогда не выдумывай и " +
  "не оценивай цифры, которых нет; (2) ты НЕ даёшь торговых советов и НЕ решаешь, входить ли в сделку — " +
  "это делает отдельный детерминированный модуль риска; (3) пиши кратко, 3-6 предложений, без markdown-" +
  "заголовков; (4) если рынок непригоден для торговли — так и скажи прямо, не смягчай.";

/**
 * Compact, deterministic facts block from an assessment. Pure and exported so
 * the exact text the model is asked to phrase can be unit-tested — the model's
 * job is wording, never arithmetic.
 */
export function formatAssessmentFacts(assessment: MarketAssessment): string {
  const lines: string[] = [
    `Просканировано пар: ${String(assessment.scannedSymbols)}.`,
    `Оценка пригодности рынка: ${String(assessment.suitabilityScore)}/100 (${assessment.suitability}).`,
    `Пар, проходящих ВСЕ три условия (ликвидность + funding + стабильность базиса): ${String(assessment.opportunities.length)}.`,
    `Пар ликвидных с funding, но со слишком волатильным базисом: ${String(assessment.fundedButVolatile)}.`,
    `Пар ликвидных, но с funding ниже порога: ${String(assessment.liquidButUnfunded)}.`,
  ];
  if (assessment.opportunities.length > 0) {
    lines.push("Возможности (лучшие по funding):");
    for (const o of assessment.opportunities.slice(0, 5)) {
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

export function buildMarketSummaryPrompt(assessment: MarketAssessment, extraContext?: string): LlmPrompt {
  const facts = formatAssessmentFacts(assessment);
  const context = extraContext && extraContext.trim().length > 0 ? `\n\nДополнительный контекст:\n${extraContext}` : "";
  return {
    system: RUSSIAN_SYSTEM_PROMPT,
    user:
      "Опиши текущее состояние рынка для funding-arbitrage стратегии на основе этих данных. " +
      "Объясни простыми словами, стоит ли сейчас запускать бота и почему.\n\n" +
      facts +
      context,
  };
}

/**
 * Trade-report facts are passed as a pre-formatted string by the caller
 * (reportGenerator already has the exact P&L breakdown) rather than re-derived
 * here — this module must not become a second place that computes money.
 */
export function buildTradeReportPrompt(reportFacts: string): LlmPrompt {
  return {
    system: RUSSIAN_SYSTEM_PROMPT,
    user:
      "Кратко опиши результат этого прогона бота простыми словами: на чём заработали или потеряли, " +
      "и что это означает. Не выдумывай цифр сверх приведённых.\n\n" +
      reportFacts,
  };
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string; code?: number };
}

/**
 * Single chat completion. Throws LlmError on any failure (network, timeout,
 * non-2xx, empty/malformed body) — callers treat that as "skip the summary",
 * never as a fatal error.
 */
export async function chat(config: LlmConfig, prompt: LlmPrompt): Promise<string> {
  const model = config.model ?? DEFAULT_LLM_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter attribution headers — harmless, and some routes rank by them.
        "X-Title": "trade-bot",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    // AbortError (timeout) and transport failures land here. Deliberately does
    // not echo the error object, which could carry request details.
    const reason = e instanceof Error && e.name === "AbortError" ? "request timed out" : "network failure";
    throw new LlmError(`LLM request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  let body: ChatResponse;
  try {
    body = (await response.json()) as ChatResponse;
  } catch {
    throw new LlmError(`LLM returned a non-JSON body (HTTP ${String(response.status)})`, response.status);
  }

  if (!response.ok) {
    throw new LlmError(
      `LLM request rejected (HTTP ${String(response.status)})`,
      response.status,
      body.error?.message,
    );
  }

  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LlmError(`LLM returned an empty completion (HTTP ${String(response.status)})`, response.status);
  }
  return content.trim();
}

export async function summarizeMarket(
  config: LlmConfig,
  assessment: MarketAssessment,
  extraContext?: string,
): Promise<string> {
  return chat(config, buildMarketSummaryPrompt(assessment, extraContext));
}

export async function summarizeTradeReport(config: LlmConfig, reportFacts: string): Promise<string> {
  return chat(config, buildTradeReportPrompt(reportFacts));
}
