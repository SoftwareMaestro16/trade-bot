import {
  OpenRouterClient,
  FallbackLlmClient,
  LlmError,
  DEFAULT_LLM_MODEL,
  FALLBACK_LLM_MODEL,
} from "./client.js";
import type { LlmClient } from "./client.js";
import type { NamedLlmClient } from "./health.js";

/**
 * Точка композиции LLM-клиентов: единственное место, где имена моделей
 * соединяются с транспортом. Основная модель берётся из конфига (по умолчанию
 * DEFAULT_LLM_MODEL), за ней всегда резервная FALLBACK_LLM_MODEL — если она не
 * совпадает с основной. Всё остальное принимает готовый LlmClient и не знает,
 * сколько моделей за ним стоит (Dependency Inversion).
 */
export interface LlmFactoryConfig {
  apiKey: string;
  /** Основная модель; по умолчанию DEFAULT_LLM_MODEL. */
  primaryModel?: string;
  requestTimeoutMs?: number;
  /** Хук лога перехода на резерв. */
  onFallback?: (failedIndex: number, error: LlmError) => void;
}

/** Упорядоченный список моделей: основная, затем резервная (без дублей). */
export function modelsFor(config: LlmFactoryConfig): string[] {
  const primary = config.primaryModel ?? DEFAULT_LLM_MODEL;
  return primary === FALLBACK_LLM_MODEL ? [primary] : [primary, FALLBACK_LLM_MODEL];
}

/**
 * Боевой клиент: основная модель с автопадением на резервную. Инструменты
 * получают его и работают, ничего не зная о переборе.
 */
export function buildFallbackClient(config: LlmFactoryConfig): LlmClient {
  const clients = modelsFor(config).map(
    (model) =>
      new OpenRouterClient({
        apiKey: config.apiKey,
        model,
        ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      }),
  );
  return new FallbackLlmClient(clients, config.onFallback);
}

/**
 * Цели для health-чека: КАЖДАЯ модель отдельным клиентом, чтобы кнопка в
 * Telegram показывала статус и основной, и резервной независимо (а не «ок» от
 * той, что успела ответить первой).
 */
export function buildHealthTargets(config: LlmFactoryConfig): NamedLlmClient[] {
  return modelsFor(config).map((model) => ({
    label: model,
    client: new OpenRouterClient({
      apiKey: config.apiKey,
      model,
      // Короткий таймаут: для проверки «жив ли» долгое ожидание — это уже «нет».
      requestTimeoutMs: config.requestTimeoutMs ?? 8_000,
    }),
  }));
}
