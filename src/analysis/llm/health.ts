import { LlmError } from "./client.js";
import type { LlmClient, LlmPrompt } from "./client.js";

/**
 * Проверка «жив ли LLM прямо сейчас» для inline-кнопки в Telegram. Отвечает на
 * вопрос владельца «а не отвалился ли API / не упёрлись ли в лимит»: пингует
 * каждую модель по отдельности крошечным промптом и возвращает статус с
 * задержкой и (при сбое) причиной от провайдера.
 *
 * Именованный клиент, а не «дай мне модель из FallbackLlmClient»: проверять
 * надо КАЖДУЮ модель отдельно (основную И резервную), иначе «ок» от резерва
 * замаскирует падение основной — а именно это и хотим видеть.
 */
export interface NamedLlmClient {
  /** Человеко-читаемая метка модели, попадает в ответ Telegram. */
  label: string;
  client: LlmClient;
}

export interface ModelHealth {
  label: string;
  ok: boolean;
  latencyMs: number | null;
  /** Причина сбоя без секретов (см. LlmError), иначе null. */
  error: string | null;
}

const HEALTH_PROMPT: LlmPrompt = {
  system: "Ты отвечаешь ровно одним словом.",
  user: "Ответь одним словом: ок",
};

/**
 * Пингует каждую модель независимо и НИКОГДА не бросает — здоровье это данные,
 * а не исключение: упавшая модель это `ok:false`, а не крах проверки. Клиентам
 * стоит задавать короткий requestTimeoutMs, чтобы «зависла» быстро отражалось
 * как недоступность, а не держало кнопку.
 *
 * `now` инъектируется (по умолчанию Date.now) — чистая точка для теста задержки
 * без реального времени.
 */
export async function checkLlmHealth(
  clients: readonly NamedLlmClient[],
  now: () => number = () => Date.now(),
): Promise<ModelHealth[]> {
  return Promise.all(
    clients.map(async ({ label, client }): Promise<ModelHealth> => {
      const started = now();
      try {
        await client.complete(HEALTH_PROMPT);
        return { label, ok: true, latencyMs: now() - started, error: null };
      } catch (e) {
        const error = e instanceof LlmError ? e.message : "неизвестный сбой";
        return { label, ok: false, latencyMs: null, error };
      }
    }),
  );
}

/** Готовый к показу в Telegram текст статуса всех моделей. */
export function formatHealthReport(results: readonly ModelHealth[]): string {
  if (results.length === 0) return "🤖 LLM не настроен (нет ключа LLM_API_KEY).";
  const lines = results.map((r) => {
    if (r.ok) return `✅ ${r.label} — работает (${String(r.latencyMs)} мс)`;
    return `❌ ${r.label} — не отвечает: ${r.error ?? "неизвестно"}`;
  });
  const anyUp = results.some((r) => r.ok);
  const header = anyUp ? "🤖 LLM доступен:" : "🤖 LLM недоступен:";
  return [header, ...lines].join("\n");
}
