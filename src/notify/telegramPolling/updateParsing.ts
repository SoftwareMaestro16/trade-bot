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

export interface ParsedUpdate {
  updateId: number | undefined;
  command: IncomingCommand | undefined;
}

/**
 * Defensive, unknown-first parse of a single raw update out of getUpdates'
 * `result` array — same "don't trust the wire" posture as telegram.ts's
 * isHasOk/safeJsonParse pair. That pair isn't exported (this file only
 * imports from telegram.ts, per the boundary this task was given), so this
 * is an independent copy of the same idea, not a reuse.
 *
 * `updateId` is extracted regardless of whether a usable command comes out
 * of the same update: the offset math in startCommandPolling must advance
 * past EVERY update Telegram handed back, including ones with no
 * `message.text` (edited_message, my_chat_member, a bot being added to a
 * group, ...) — an update that never contributes to `offset` gets
 * redelivered by Telegram on every subsequent poll, forever.
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

  return { updateId, command };
}

export { asRecord, safeJsonParse, parseUpdate };
