import { routeAuthorizedCommand } from "./commandRouter.js";
import type { CommandRouterDeps } from "./commandRouter.js";
import type { InlineKeyboardMarkup } from "../notify/telegram.js";

/**
 * Owner's own request: "можно попытаться ещё реализовать команды в inline
 * кнопках нажимать и делать действия всякие" — tapped-button counterpart to
 * commandRouter.ts's routeAuthorizedCommand, reached from a callback_query
 * instead of typed text (see notify/telegramPolling/loop.ts's
 * onCallbackQuery and updateParsing.ts's ParsedCallbackQuery). Every tap
 * already passed the SAME authorizeCommand/isAuthorizedChat gate a typed
 * command does before this function is ever called — see
 * killswitch-listener.ts's own onCallbackQuery wiring.
 *
 * callback_data vocabulary (bare strings, no leading "/", no args — see
 * telegram.ts's InlineKeyboardButton doc comment for why):
 *   "status" | "help" | "resume"          -> delegates straight to
 *                                            routeAuthorizedCommand, byte-for-
 *                                            byte the same action a typed
 *                                            command would take.
 *   "stop_confirm" | "flatten_confirm"    -> does NOT execute anything yet.
 *                                            Edits the menu message in place
 *                                            to a warning + a [Yes]/[Cancel]
 *                                            row. A single mistap on Stop/
 *                                            Flatten deserves a second tap to
 *                                            confirm — typing the full command
 *                                            text already has that friction
 *                                            built in, a button doesn't.
 *   "stop_execute" | "flatten_execute"    -> the actual action, only reachable
 *                                            after the confirm step above.
 *   "cancel"                              -> reverts the message back to the
 *                                            main menu, no action taken.
 */

export const MENU_TEXT = "Быстрые действия:";

export const MENU_KEYBOARD: InlineKeyboardMarkup = {
  inlineKeyboard: [
    [
      { text: "📊 Статус", callbackData: "status" },
      { text: "❓ Помощь", callbackData: "help" },
    ],
    [{ text: "✅ Resume", callbackData: "resume" }],
    [
      { text: "🛑 Stop", callbackData: "stop_confirm" },
      { text: "🔥 Flatten", callbackData: "flatten_confirm" },
    ],
  ],
};

const STOP_CONFIRM_TEXT =
  "🛑 Точно остановить новые входы (HALT_NEW)? Существующие позиции это не тронет.";
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
  /** MUST be called exactly once per callback_query, whether or not it led to an action — see notify/telegram.ts's answerCallbackQuery doc comment for why. */
  answerCallback: (callbackQueryId: string, toastText?: string) => Promise<void>;
}

export function routeCallbackQuery(
  data: string,
  chatId: string,
  messageId: number,
  callbackQueryId: string,
  deps: ButtonRouterDeps,
): void {
  switch (data) {
    case "status":
    case "help":
    case "resume":
      routeAuthorizedCommand(data, [], chatId, deps);
      void deps.answerCallback(callbackQueryId);
      break;

    case "stop_confirm":
      void deps.editMenuMessage(messageId, STOP_CONFIRM_TEXT, STOP_CONFIRM_KEYBOARD);
      void deps.answerCallback(callbackQueryId);
      break;

    case "flatten_confirm":
      void deps.editMenuMessage(messageId, FLATTEN_CONFIRM_TEXT, FLATTEN_CONFIRM_KEYBOARD);
      void deps.answerCallback(callbackQueryId);
      break;

    case "stop_execute":
      routeAuthorizedCommand("stop", [], chatId, deps);
      void deps.editMenuMessage(messageId, "✅ HALT_NEW включён.", { inlineKeyboard: [] });
      void deps.answerCallback(callbackQueryId, "Остановлено");
      break;

    case "flatten_execute":
      routeAuthorizedCommand("flatten", [], chatId, deps);
      void deps.editMenuMessage(messageId, "✅ FLATTEN_ALL включён.", { inlineKeyboard: [] });
      void deps.answerCallback(callbackQueryId, "Flatten активирован");
      break;

    case "cancel":
      void deps.editMenuMessage(messageId, MENU_TEXT, MENU_KEYBOARD);
      void deps.answerCallback(callbackQueryId, "Отменено");
      break;

    default:
      deps.logger.info({ data }, "unrecognized callback_data");
      void deps.answerCallback(callbackQueryId);
  }
}
