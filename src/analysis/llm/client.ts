/**
 * LLM-клиент для АННОТАЦИЙ — резюме рынка и отчётов простым языком. Две
 * жёсткие границы, обе намеренные:
 *
 *  1. Никогда не участвует в торговом решении. risk/ детерминирован и покрыт
 *     юнит-тестами (ARCHITECTURE.md §2); недетерминированная модель в цепочке
 *     вето не тестируема и была бы единственным узлом, способным
 *     непредсказуемо терять деньги. Инструменты выше по стеку получают уже
 *     ПРИНЯТУЮ оценку и только переформулируют её словами.
 *
 *  2. Никогда не ломает пайплайн — но это ответственность инструмента
 *     (tools/analysisTool.ts перехватывает сбой и отдаёт narrative=null), а не
 *     клиента. Клиент — узкая абстракция «дай текст по промпту», и на сбое он
 *     ЧЕСТНО бросает LlmError, а не глотает его молча: глотание — политика
 *     конкретного места вызова, а не транспорта.
 *
 * Голый `fetch` к OpenAI-совместимому эндпоинту OpenRouter, без @openrouter/sdk
 * и LangChain — по той же причине, что notify/telegram.ts не тащит grammY: один
 * HTTP-вызов и один разбор поля не оправдывают зависимость-фреймворк.
 */

export interface LlmPrompt {
  system: string;
  user: string;
}

/**
 * Абстракция, от которой зависят все инструменты (Dependency Inversion).
 * Ровно один метод (Interface Segregation): «по промпту верни текст или брось».
 * Любая реализация взаимозаменяема (Liskov) — прод берёт OpenRouterClient,
 * тесты подставляют фейк, и ни один инструмент не знает разницы.
 */
export interface LlmClient {
  complete(prompt: LlmPrompt): Promise<string>;
}

/**
 * Несёт только HTTP-статус и текст ошибки провайдера — никогда не запрос,
 * в котором `Authorization: Bearer <key>`. Та же дисциплина сокрытия, что у
 * TelegramApiError: ни одно поле не может держать ключ, даже косвенно через
 * припрятанный сырой объект ответа.
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

export const LLM_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/**
 * Основная модель. Выбрана эмпирически (2026-08-11): nvidia/nemotron-3.5-
 * lightning оказалась «думающей» — сыпала ход рассуждений по-английски прямо в
 * ответ, игнорируя и жёсткий промпт, и reasoning.exclude (её рассуждения без
 * тегов, strip их не ловит). ling-3.0-tiny на том же промпте даёт короткое
 * чистое русское резюме — поэтому она основная.
 */
export const DEFAULT_LLM_MODEL = "inclusionai/ling-3.0-tiny:free";
/**
 * Резервные модели по порядку — все бесплатные instruct-маршруты OpenRouter,
 * без «мыслей вслух». Специально НЕ nemotron: падать на модель, которая выдаёт
 * мусор, хуже, чем показать рынок без резюме. Несколько штук — потому что у
 * free-tier жёсткие лимиты (429): чем длиннее цепочка, тем выше шанс, что хоть
 * одна ответит. ВАЖНО: у OpenRouter лимит free ещё и на уровне АККАУНТА (общий
 * дневной/минутный), и если упёрлись в него — 429 отдадут все модели разом;
 * тогда резюме просто не покажется (рынок покажется без него), а поднять лимит
 * можно небольшим депозитом на OpenRouter.
 */
export const FALLBACK_LLM_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "openai/gpt-oss-20b:free",
];
const DEFAULT_TIMEOUT_MS = 30_000;
// Headroom так, что даже «думающая» модель, слившая часть бюджета на
// рассуждения, всё равно дойдёт до финального ответа — иначе ответ обрывается
// на полуслове (наблюдалось у nemotron 2026-08-11).
const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_TEMPERATURE = 0.3;

/**
 * Убирает «мысли вслух» из ответа: reasoning-модели заворачивают рассуждения в
 * теги <think>/<thinking>/<reasoning> и выдают их в content. Показывать это
 * пользователю нельзя — режем блоки, оставляя только финал. Чистая функция,
 * экспортирована для теста. Не панацея против моделей, которые сыплют
 * рассуждениями без тегов вообще — от таких спасает выбор модели и промпт.
 */
export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

export interface OpenRouterConfig {
  apiKey: string;
  /** По умолчанию DEFAULT_LLM_MODEL. */
  model?: string;
  requestTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string; code?: number };
}

/**
 * Единственная реализация LlmClient поверх OpenRouter. Знает только про
 * транспорт: собрать тело, вызвать, разобрать одно поле, при любой беде
 * бросить LlmError (сеть, таймаут, не-2xx, пустой/битый ответ). Ничего не знает
 * про рынок, сделки и промпты — это забота инструментов (Single Responsibility).
 */
export class OpenRouterClient implements LlmClient {
  constructor(private readonly config: OpenRouterConfig) {}

  async complete(prompt: LlmPrompt): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(LLM_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          // Атрибуция OpenRouter — безвредна, некоторые маршруты её учитывают.
          "X-Title": "trade-bot",
        },
        body: JSON.stringify({
          model: this.config.model ?? DEFAULT_LLM_MODEL,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: this.config.temperature ?? DEFAULT_TEMPERATURE,
          // OpenRouter: для reasoning-моделей не возвращать токены рассуждений —
          // нам нужен только финальный ответ. Модели без reasoning параметр
          // игнорируют, так что это безопасно на любом маршруте.
          reasoning: { exclude: true },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      // Сюда попадают AbortError (таймаут) и сбои транспорта. Намеренно не
      // эхопечатаем объект ошибки — он мог бы нести детали запроса.
      const reason = e instanceof Error && e.name === "AbortError" ? "истёк таймаут" : "сбой сети";
      throw new LlmError(`LLM-запрос не удался: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    let body: ChatResponse;
    try {
      body = (await response.json()) as ChatResponse;
    } catch {
      throw new LlmError(`LLM вернул не-JSON тело (HTTP ${String(response.status)})`, response.status);
    }

    if (!response.ok) {
      throw new LlmError(
        `LLM-запрос отклонён (HTTP ${String(response.status)})`,
        response.status,
        body.error?.message,
      );
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new LlmError(`LLM вернул пустой ответ (HTTP ${String(response.status)})`, response.status);
    }
    const cleaned = stripReasoningBlocks(content);
    // Если после вырезания тегов не осталось ничего (весь ответ был
    // рассуждением) — это тоже пустой ответ, а не молча возвращаемая пустышка.
    if (cleaned.length === 0) {
      throw new LlmError(`LLM вернул только рассуждения, без ответа (HTTP ${String(response.status)})`, response.status);
    }
    return cleaned;
  }
}

/**
 * Композит из нескольких клиентов: пробует по порядку, отдаёт первый успех.
 * Реализует тот же LlmClient (Liskov) — вызывающий не знает, что внутри
 * перебор. Open/Closed: добавить ещё одну резервную модель — это ещё один
 * элемент списка, класс не меняется. `onFallback` — необязательный хук для
 * лога, чтобы было видно, когда основная модель отвалилась.
 */
export class FallbackLlmClient implements LlmClient {
  constructor(
    private readonly clients: readonly LlmClient[],
    private readonly onFallback?: (failedIndex: number, error: LlmError) => void,
  ) {
    if (clients.length === 0) {
      throw new Error("FallbackLlmClient требует хотя бы одного клиента");
    }
  }

  async complete(prompt: LlmPrompt): Promise<string> {
    let lastError: LlmError | undefined;
    for (let i = 0; i < this.clients.length; i++) {
      try {
        return await this.clients[i]!.complete(prompt);
      } catch (e) {
        // Перебираем только на LlmError (сеть/лимит/битый ответ) — это ровно
        // те сбои, ради которых резерв и нужен. Любое иное исключение (баг в
        // коде) пробрасываем немедленно, не маскируя его перебором.
        if (!(e instanceof LlmError)) throw e;
        lastError = e;
        if (i < this.clients.length - 1) this.onFallback?.(i, e);
      }
    }
    // Все клиенты упали — отдаём последнюю ошибку, а не глотаем.
    throw lastError ?? new LlmError("FallbackLlmClient: ни один клиент не ответил");
  }
}
