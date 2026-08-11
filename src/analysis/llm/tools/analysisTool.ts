import { LlmError } from "../client.js";
import type { LlmClient, LlmPrompt } from "../client.js";

/**
 * Общий контракт инструмента анализа. Каждый инструмент делает ОДНУ вещь
 * (Single Responsibility) и взаимозаменяем с другими через этот интерфейс
 * (Liskov): реестр и вызывающий код работают с любым инструментом одинаково,
 * не зная его внутренностей.
 *
 * `TInput` — уже посчитанные детерминированные данные (оценка рынка, разбивка
 * P&L); инструмент их НЕ добывает и НЕ пересчитывает деньги, только описывает.
 */
export interface AnalysisTool<TInput, TData> {
  readonly name: string;
  readonly description: string;
  run(input: TInput): Promise<Narrated<TData>>;
}

/**
 * Результат инструмента: детерминированные `data` присутствуют ВСЕГДА, а
 * `narrative` — необязательное словесное резюме от LLM. `narrative === null`
 * означает, что LLM был недоступен; это не ошибка вызывающего, а штатная
 * деградация (паттерн Null Object). Так аннотация физически не может уронить
 * пайплайн: отчёт уходит с `data` в любом случае.
 */
export interface Narrated<TData> {
  data: TData;
  narrative: string | null;
  /** Причина отсутствия резюме (без секретов — см. LlmError), иначе null. */
  llmError: string | null;
}

/**
 * База для инструмента вида «посчитать детерминированно → попросить LLM
 * переформулировать». Шаблонный метод `run` фиксирует инвариант (сначала
 * данные, потом безопасный вызов LLM, потом сборка результата), а наследник
 * заполняет только две чистые операции. Отсюда весь SOLID набор:
 *
 *  - SRP: база = оркестрация и деградация; наследник = предметная логика.
 *  - OCP: новый инструмент добавляется наследованием, база не трогается.
 *  - DIP: зависимость на абстракции LlmClient, а не на OpenRouterClient.
 *
 * `computeData` и `buildPrompt` ДОЛЖНЫ быть чистыми (без сети, без БД, без
 * времени) — тогда их можно тестировать без LLM, а `run` тестируется с фейковым
 * клиентом. Ни один сбой LLM не пробрасывается наружу: он превращается в
 * `narrative: null` + `llmError`.
 */
export abstract class NarratingTool<TInput, TData> implements AnalysisTool<TInput, TData> {
  abstract readonly name: string;
  abstract readonly description: string;

  constructor(protected readonly llm: LlmClient) {}

  /** Чистый детерминированный расчёт из входных данных. */
  protected abstract computeData(input: TInput): TData;

  /** Чистая сборка промпта из посчитанных данных — только реальные числа. */
  protected abstract buildPrompt(data: TData, input: TInput): LlmPrompt;

  async run(input: TInput): Promise<Narrated<TData>> {
    const data = this.computeData(input);
    try {
      const narrative = await this.llm.complete(this.buildPrompt(data, input));
      return { data, narrative, llmError: null };
    } catch (e) {
      // Аннотация не должна ронять отчёт: любой сбой LLM — это отсутствие
      // резюме, а не исключение. Наружу отдаём отредактированную причину.
      const llmError = e instanceof LlmError ? e.message : "сбой LLM";
      return { data, narrative: null, llmError };
    }
  }
}

/**
 * Общий системный промпт для русскоязычных резюме. Держит модель в рамках
 * аннотатора: только данные из ввода, никаких торговых советов, кратко.
 * Вынесен сюда, чтобы все инструменты делили одну формулировку ограничений
 * (DRY), а не расходились копиями.
 */
export const RUSSIAN_ANALYST_SYSTEM_PROMPT =
  "Ты — аналитик, который описывает состояние рынка простым русским языком для владельца торгового бота.\n" +
  "ФОРМАТ ОТВЕТА (обязательно):\n" +
  "- Пиши ТОЛЬКО на русском языке.\n" +
  "- Отвечай СРАЗУ готовым резюме. НЕ показывай ход рассуждений, не пиши 'thinking', 'draft', 'let me', " +
  "не разбирай задачу по пунктам, не пиши по-английски.\n" +
  "- Коротко: 2-4 простых предложения. Без markdown, без заголовков, без списков.\n" +
  "СОДЕРЖАНИЕ:\n" +
  "- Используй ТОЛЬКО числа из вводных. Никогда не выдумывай и не оценивай цифры, которых нет.\n" +
  "- Ты НЕ даёшь торговых советов и НЕ решаешь, входить ли в сделку, — это делает отдельный модуль риска.\n" +
  "- Если рынок непригоден для торговли — скажи прямо, не смягчай.";
