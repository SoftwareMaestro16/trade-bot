import type { IncomingCommand } from "../telegram.js";

/**
 * Split out of telegramPolling.ts (now this folder's barrel) — raw update
 * parsing, independent of the long-poll loop mechanics in ./loop.ts.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One tap of an inline keyboard button (see telegram.ts's InlineKeyboardMarkup
 * and killswitch/buttonRouter.ts). `id` is Telegram's own callback_query id —
 * required by answerCallbackQuery, unrelated to `updateId`. `messageId` is the
 * id of the message the tapped button was attached to, needed by
 * editMessageText to update that same message in place (e.g. swapping a
 * confirm prompt's buttons for a "done" state).
 */
export interface ParsedCallbackQuery {
  id: string;
  chatId: string;
  messageId: number;
  data: string;
}

export interface ParsedUpdate {
  updateId: number | undefined;
  command: IncomingCommand | undefined;
  callbackQuery: ParsedCallbackQuery | undefined;
}

function parseCallbackQuery(raw: unknown): ParsedCallbackQuery | undefined {
  const cq = asRecord(raw);
  if (!cq) return undefined;

  const id = cq.id;
  const data = cq.data;
  const message = asRecord(cq.message);
  const messageId = message?.message_id;
  const chat = asRecord(message?.chat);
  const chatId = chat?.id;

  if (
    typeof id !== "string" ||
    typeof data !== "string" ||
    typeof messageId !== "number" ||
    (typeof chatId !== "string" && typeof chatId !== "number")
  ) {
    return undefined;
  }

  return { id, chatId: String(chatId), messageId, data };
}

/**
 * Defensive, unknown-first parse of a single raw update out of getUpdates'
 * `result` array — same "don't trust the wire" posture as telegram.ts's
 * isHasOk/safeJsonParse pair. That pair isn't exported (this file only
 * imports from telegram.ts, per the boundary this task was given), so this
 * is an independent copy of the same idea, not a reuse.
 *
 * `updateId` is extracted regardless of whether a usable command/callbackQuery
 * comes out of the same update: the offset math in startCommandPolling must
 * advance past EVERY update Telegram handed back, including ones that are
 * neither (edited_message, my_chat_member, a bot being added to a group, an
 * inline_query, ...) — an update that never contributes to `offset` gets
 * redelivered by Telegram on every subsequent poll, forever.
 *
 * A single update is either a `message` or a `callback_query`, never both
 * (Telegram's own update shape) — `command` and `callbackQuery` are
 * therefore mutually exclusive on any one ParsedUpdate, not independently
 * optional.
 */
function parseUpdate(raw: unknown): ParsedUpdate {
  const update = asRecord(raw);
  const updateId = update && typeof update.update_id === "number" ? update.update_id : undefined;

  const message = asRecord(update?.message);
  const text = message?.text;
  const chat = asRecord(message?.chat);
  const chatId = chat?.id;

  const command =
    typeof text === "string" && (typeof chatId === "string" || typeof chatId === "number")
      ? { chatId: String(chatId), text }
      : undefined;

  const callbackQuery = parseCallbackQuery(update?.callback_query);

  return { updateId, command, callbackQuery };
}

export { asRecord, safeJsonParse, parseUpdate };
