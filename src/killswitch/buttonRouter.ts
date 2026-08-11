import { routeAuthorizedCommand } from "./commandRouter.js";
import type { CommandRouterDeps } from "./commandRouter.js";
import type { InlineKeyboardMarkup } from "../notify/telegram.js";

/**
 * Tapped-button counterpart to commandRouter.ts's routeAuthorizedCommand,
 * reached from a callback_query (see notify/telegramPolling/loop.ts). Every tap
 * already passed the SAME authorizeCommand/isAuthorizedChat gate a typed command
 * does before this function is called.
 *
 * Навигация — деревом через editMessageText НА МЕСТЕ, без спама новыми
 * сообщениями: главное меню -> раздел -> «⬅️ Меню» назад. Тяжёлые отчёты
 * (Статус/Помощь — это Bot API rich-таблицы) по-прежнему шлются отдельным
 * сообщением; лёгкие представления (Рынок, LLM) редактируют то же сообщение.
 *
 * callback_data (голые строки, без ведущего "/", без аргументов):
 *   "menu"                                -> вернуться в главное меню (правит на месте).
 *   "status" | "help"                     -> тяжёлый отчёт отдельным сообщением (делегирует).
 *   "manage"                              -> подменю управления торговлей.
 *   "resume"                              -> снять halt (▶️ Начать) + правка на подтверждение.
 *   "market"                              -> собрать оценку рынка, показать на месте.
 *   "market_llm"                          -> то же + резюме LLM.
 *   "llm_health"                          -> пинг моделей, показать что живо.
 *   "stop_confirm" | "flatten_confirm"    -> НЕ исполняет: правит на предупреждение + [Да]/[Отмена].
 *   "stop_execute" | "flatten_execute"    -> реальное действие, достижимо только после confirm.
 *   "cancel"                              -> вернуть сообщение в главное меню, без действия.
 *
 * Kill-switch flow (stop/flatten/cancel) сохранён без изменений — это
 * safety-critical и покрыто тестами; расширение только добавляет разделы вокруг.
 */

export const MENU_TEXT = "🏠 Главное меню:";

export const MENU_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [
      { text: "📊 Статус", callbackData: "status" },
      { text: "📈 Рынок", callbackData: "market" },
    ],
    [{ text: "🤖 LLM", callbackData: "llm_health" }],
    [{ text: "🎛 Управление", callbackData: "manage" }],
    [{ text: "❓ Помощь", callbackData: "help" }],
  ],
};

const MANAGE_TEXT = "🎛 Управление торговлей:";
const MANAGE_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [{ text: "▶️ Начать", callbackData: "resume" }],
    [{ text: "⏸ Остановить", callbackData: "stop_confirm" }],
    [{ text: "🔥 Закрыть всё", callbackData: "flatten_confirm" }],
    [{ text: "⬅️ Меню", callbackData: "menu" }],
  ],
};

const MARKET_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [
      { text: "🧠 Резюме LLM", callbackData: "market_llm" },
      { text: "🔄 Обновить", callbackData: "market" },
    ],
    [{ text: "⬅️ Меню", callbackData: "menu" }],
  ],
};

const LLM_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [{ text: "🔄 Проверить снова", callbackData: "llm_health" }],
    [{ text: "⬅️ Меню", callbackData: "menu" }],
  ],
};

/** Пока грузятся асинхронные данные — только выход в меню. */
const BACK_ONLY_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [[{ text: "⬅️ Меню", callbackData: "menu" }]],
};

const STOP_CONFIRM_TEXT = "🛑 Точно остановить новые входы (HALT_NEW)? Существующие позиции это не тронет.";
const FLATTEN_CONFIRM_TEXT =
  "🔥 Точно закрыть ВСЁ (FLATTEN_ALL)? Блокирует новые входы и помечает всё к закрытию " +
  "(execution/ ещё не подключён — реального закрытия позиций пока не произойдёт).";

const STOP_CONFIRM_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [
      { text: "Да, остановить", callbackData: "stop_execute" },
      { text: "Отмена", callbackData: "cancel" },
    ],
  ],
};
const FLATTEN_CONFIRM_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [
      { text: "Да, закрыть всё", callbackData: "flatten_execute" },
      { text: "Отмена", callbackData: "cancel" },
    ],
  ],
};

export interface ButtonRouterDeps extends CommandRouterDeps {
  /** Edits the tapped button's own message in place — see notify/telegram.ts's editMessageText. Pass {inlineKeyboard: []} to clear the buttons entirely. */
  editMenuMessage: (messageId: number, text: string, keyboard: InlineKeyboardMarkup) => Promise<void>;
  /** MUST be called exactly once per callback_query — see notify/telegram.ts's answerCallbackQuery doc comment. */
  answerCallback: (callbackQueryId: string, toastText?: string) => Promise<void>;
  /** Собирает и форматирует оценку рынка (без LLM). Никогда не бросает — на сбое отдаёт текст ошибки. */
  renderMarket: () => Promise<string>;
  /** То же + резюме LLM. При отсутствии/сбое LLM отдаёт оценку без резюме. */
  renderMarketLlm: () => Promise<string>;
  /** Отчёт о доступности моделей LLM. Никогда не бросает. */
  checkLlm: () => Promise<string>;
}

/**
 * Загрузка-затем-результат для async-разделов: сразу правит на «⏳ …» (мгновенный
 * отклик), потом на результат. render не должен бросать (renderMarket и др.
 * оборачивают сбои), try/catch — страховка, чтобы кнопка не зависла на «⏳».
 */
async function showAsync(
  deps: ButtonRouterDeps,
  messageId: number,
  loadingText: string,
  render: () => Promise<string>,
  resultKeyboard: InlineKeyboardMarkup,
): Promise<void> {
  await deps.editMenuMessage(messageId, loadingText, BACK_ONLY_KEYBOARD);
  let text: string;
  try {
    text = await render();
  } catch (e) {
    deps.logger.error({ err: e }, "async menu render threw");
    text = "⚠️ Не удалось получить данные. Попробуйте ещё раз.";
  }
  await deps.editMenuMessage(messageId, text, resultKeyboard);
}

export async function routeCallbackQuery(
  data: string,
  chatId: string,
  messageId: number,
  callbackQueryId: string,
  deps: ButtonRouterDeps,
): Promise<void> {
  switch (data) {
    case "status":
    case "help":
      // Тяжёлый rich-отчёт отдельным сообщением — делегируем как типизированной команде.
      routeAuthorizedCommand(data, [], chatId, deps);
      void deps.answerCallback(callbackQueryId);
      return;

    case "menu":
      void deps.editMenuMessage(messageId, MENU_TEXT, MENU_KEYBOARD);
      void deps.answerCallback(callbackQueryId);
      return;

    case "manage":
      void deps.editMenuMessage(messageId, MANAGE_TEXT, MANAGE_KEYBOARD);
      void deps.answerCallback(callbackQueryId);
      return;

    case "resume":
      routeAuthorizedCommand("resume", [], chatId, deps);
      void deps.editMenuMessage(messageId, "▶️ Торговля запущена — halt снят (новые входы разрешены).", MANAGE_KEYBOARD);
      void deps.answerCallback(callbackQueryId, "Запущено");
      return;

    case "market":
      void deps.answerCallback(callbackQueryId);
      await showAsync(deps, messageId, "⏳ Собираю оценку рынка…", deps.renderMarket, MARKET_KEYBOARD);
      return;

    case "market_llm":
      void deps.answerCallback(callbackQueryId);
      await showAsync(deps, messageId, "⏳ Спрашиваю LLM…", deps.renderMarketLlm, MARKET_KEYBOARD);
      return;

    case "llm_health":
      void deps.answerCallback(callbackQueryId);
      await showAsync(deps, messageId, "⏳ Проверяю модели…", deps.checkLlm, LLM_KEYBOARD);
      return;

    case "stop_confirm":
      void deps.editMenuMessage(messageId, STOP_CONFIRM_TEXT, STOP_CONFIRM_KEYBOARD);
      void deps.answerCallback(callbackQueryId);
      return;

    case "flatten_confirm":
      void deps.editMenuMessage(messageId, FLATTEN_CONFIRM_TEXT, FLATTEN_CONFIRM_KEYBOARD);
      void deps.answerCallback(callbackQueryId);
      return;

    case "stop_execute":
      routeAuthorizedCommand("stop", [], chatId, deps);
      void deps.editMenuMessage(messageId, "✅ HALT_NEW включён.", { inlineKeyboard: [] });
      void deps.answerCallback(callbackQueryId, "Остановлено");
      return;

    case "flatten_execute":
      routeAuthorizedCommand("flatten", [], chatId, deps);
      void deps.editMenuMessage(messageId, "✅ FLATTEN_ALL включён.", { inlineKeyboard: [] });
      void deps.answerCallback(callbackQueryId, "Flatten активирован");
      return;

    case "cancel":
      void deps.editMenuMessage(messageId, MENU_TEXT, MENU_KEYBOARD);
      void deps.answerCallback(callbackQueryId, "Отменено");
      return;

    default:
      deps.logger.info({ data }, "unrecognized callback_data");
      void deps.answerCallback(callbackQueryId);
      return;
  }
}
