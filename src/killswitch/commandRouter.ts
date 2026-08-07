import type { Logger } from "pino";
import { applyFlattenAll, applyHaltNew, clearHalt } from "./haltState.js";
import type { HaltState } from "./haltState.js";
import type { InFlightTracker } from "./inFlightPersists.js";
import type { TelegramConfig } from "../notify/telegram.js";

/**
 * Extracted from killswitch-listener.ts's main() so handleAuthorizedCommand
 * (now routeAuthorizedCommand below) can be unit-tested in isolation, with
 * mock/stub dependencies, instead of only via a manual SSH smoke test against
 * the real process. main() previously closed over `state`,
 * `inFlightPersists`, `applyAndPersist`, `sendStatusReport`,
 * `manageAuthorizedUser`, and `telegramConfig` directly; those are now
 * explicit parameters (bundled as `CommandRouterDeps`) instead of closures,
 * with no change to what gets called, in what order, or with what
 * arguments — see killswitch-listener.ts's main() for how the real
 * dependencies are constructed and passed in.
 */
export interface CommandRouterDeps {
  /**
   * Reads main()'s own mutable `state` variable at the moment it's called —
   * a getter rather than a plain `HaltState` value because `state` is
   * reassigned by `applyAndPersist` on every halt/resume transition, and
   * each command below needs whatever the CURRENT value is at dispatch time,
   * not a value captured once when the router was constructed.
   */
  getState: () => HaltState;
  inFlightPersists: InFlightTracker;
  applyAndPersist: (next: HaltState, logLine: string) => Promise<void>;
  sendStatusReport: () => Promise<void>;
  sendHelp: () => Promise<void>;
  sendMenu: () => Promise<void>;
  manageAuthorizedUser: (
    command: "add" | "delete",
    candidate: string | undefined,
    senderChatId: string,
    rootAdminChatId: string,
  ) => Promise<void>;
  telegramConfig: TelegramConfig | null;
  logger: Logger;
}

/**
 * Owner's own request: "/help красиво с маркдаун форматированием в таблице
 * выведет все команды как использовать и для чего" — a single source of
 * truth for what each command does, kept in this file specifically (not
 * notify/) so it sits next to the switch statement below it documents and
 * can't quietly drift out of sync with it unnoticed. notify/helpText.ts's
 * formatHelpTable renders this array as a Bot API 10.1 markdown table (see
 * that file for why a real table, not monospace `<code>` alignment).
 */
export interface CommandDoc {
  usage: string;
  description: string;
}

export const COMMAND_DOCS: readonly CommandDoc[] = [
  { usage: "/stop", description: "HALT_NEW — блокирует новые входы в позиции. Существующие позиции не трогает." },
  {
    usage: "/flatten",
    description:
      "FLATTEN_ALL — блокирует новые входы и закрывает всё существующее " +
      "(сегодня только выставляет флаг: реального закрытия позиций ещё нет, execution/ order placement не подключён).",
  },
  {
    usage: "/resume [причина]",
    description: "Снимает halt (оба флага). Причина — свободный текст, попадает в лог как подтверждение.",
  },
  {
    usage: "/status",
    description: "Отчёт одним сообщением: kill switch, свежесть данных по таблицам, статистика последних циклов сбора.",
  },
  { usage: "/add <chat_id>", description: "Добавляет chat_id в список авторизованных отправителей команд. Только root admin." },
  { usage: "/delete <chat_id>", description: "Убирает chat_id из списка авторизованных. Только root admin." },
  {
    usage: "/menu (или /start)",
    description: "Быстрые кнопки-действия вместо набора команд текстом — см. killswitch/buttonRouter.ts.",
  },
  { usage: "/help", description: "Этот список." },
];

// RR-33 (extended): only a chat_id that's either the root admin or already
// in the authorized_users table ever reaches this function at all —
// isAuthorizedChat/authorizeCommand have already filtered by the time
// startCommandPolling calls onCommand. `chatId` is that already-authorized
// sender, needed here specifically for /add and /delete: those two
// commands are further restricted to ONLY the root admin, not every
// authorized chat_id — see the "add"/"delete" case below.
export function routeAuthorizedCommand(command: string, args: string[], chatId: string, deps: CommandRouterDeps): void {
  const {
    getState,
    inFlightPersists,
    applyAndPersist,
    sendStatusReport,
    sendHelp,
    sendMenu,
    manageAuthorizedUser,
    telegramConfig,
    logger,
  } = deps;

  switch (command) {
    case "stop":
      inFlightPersists.track(
        applyAndPersist(
          applyHaltNew(getState(), "manual /stop", "telegram", Date.now()),
          "🛑 <b>HALT_NEW</b> — new entries blocked via /stop",
        ),
      );
      break;

    case "flatten":
      inFlightPersists.track(
        applyAndPersist(
          applyFlattenAll(getState(), "manual /flatten", "telegram", Date.now()),
          "🛑 <b>FLATTEN_ALL</b> — new entries blocked, closing everything, via /flatten " +
            "(no execution/ order placement exists yet — this raises the flag for when it does)",
        ),
      );
      break;

    case "resume": {
      const confirmedBy = `telegram:${args.join(" ") || "operator"}`;
      try {
        const cleared = clearHalt(getState(), confirmedBy, Date.now());
        inFlightPersists.track(applyAndPersist(cleared, `✅ Halt cleared via /resume (confirmed by ${confirmedBy})`));
      } catch (e) {
        logger.error({ err: e }, "/resume rejected");
      }
      break;
    }

    case "status":
      void sendStatusReport();
      break;

    case "help":
      void sendHelp();
      break;

    case "menu":
    case "start":
      void sendMenu();
      break;

    // Owner's own requirement: /add and /delete manage WHO can issue any
    // of the commands above, so they must be restricted to the root admin
    // ONLY — a chat_id merely present in authorized_users (and therefore
    // already able to reach this function per the comment above) must NOT
    // be able to authorize further chat_ids or de-authorize others. No
    // reply is sent to the rejecting chat_id: there is no general
    // "reply to an arbitrary chat_id" mechanism in this codebase (outbound
    // sendAlert/sendRichMessage/sendDocument all target config.allowedChatId
    // only, deliberately untouched by this change), so this is
    // logged-and-silently-dropped, same as an RR-33 rejection.
    case "add":
    case "delete":
      if (!telegramConfig) {
        logger.error({ chatId, command, args }, `REJECTED /${command} — Telegram is not configured`);
        break;
      }
      // The root-admin-only gate is also enforced inside
      // manageAuthorizedUserCommand itself (manageAuthorizedUser above logs
      // its "rejected_not_root_admin" outcome loudly if that ever
      // triggers) — checked here too so a non-root sender's attempt is
      // logged immediately, without an extra DB round trip.
      if (chatId !== telegramConfig.allowedChatId) {
        logger.error(
          { chatId, command, args },
          `REJECTED /${command} — only the root admin chat_id may manage authorized_users`,
        );
        break;
      }
      void manageAuthorizedUser(command, args[0], chatId, telegramConfig.allowedChatId);
      break;

    default:
      logger.info({ command }, "unrecognized command");
  }
}
