import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import { sendAlert, sendRichMessage } from "./telegram.js";
import type { SendAlertOptions, TelegramConfig } from "./telegram.js";

// `pending_telegram_messages.parse_mode` has no DB-level CHECK constraint
// (migration comment: "'HTML' or NULL, mirrors SendAlertOptions.parseMode") —
// this sentinel reuses that same free-text column to mark a queued message as
// a Bot API 10.1 rich/table message rather than adding a new column/table for
// what is, from this queue's point of view, still just "one more delivery
// mode for one text blob."
const RICH_MARKDOWN_MARKER = "rich_markdown";

/**
 * Owner request: a message that fails to send must not simply vanish — it
 * should sit somewhere durable ("мемпул") and get delivered once it can be,
 * including across a process restart (a message that failed because the
 * WHOLE PROCESS was down needs a startup-time retry, not just a periodic
 * one — see collector.ts's own wiring of `deliverPending`). Backed by
 * migrations/1786029586940_create-pending-telegram-messages.sql, not an
 * in-memory queue: an in-memory queue is exactly as durable as the process
 * that just crashed, which is the one case this exists to cover.
 *
 * Deliberately generic, not digest-specific — any `sendAlert` caller
 * (killswitch-listener.ts's alerts, future notification types) can use the
 * same queue rather than each growing its own bespoke retry logic.
 */
export async function enqueueNotification(
  db: Kysely<Database>,
  text: string,
  options?: SendAlertOptions,
): Promise<void> {
  await db
    .insertInto("pending_telegram_messages")
    .values({ message_text: text, parse_mode: options?.parseMode ?? null })
    .execute();
}

/**
 * Same durable-queue guarantee as `enqueueNotification`, for a `sendRichMessage`
 * (Bot API 10.1 table/rich-block) markdown body instead of a plain `sendAlert`
 * text — `deliverPending` below dispatches to the right Telegram method by
 * checking for `RICH_MARKDOWN_MARKER` in `parse_mode`.
 */
export async function enqueueRichNotification(db: Kysely<Database>, markdown: string): Promise<void> {
  await db
    .insertInto("pending_telegram_messages")
    .values({ message_text: markdown, parse_mode: RICH_MARKDOWN_MARKER })
    .execute();
}

export interface DeliverPendingResult {
  delivered: number;
  stillFailing: number;
}

/**
 * Attempts every undelivered message, OLDEST FIRST — so a backlog drains in
 * the order it accumulated, matching what a reader would expect scrolling
 * their chat. Sequential, not parallel: this queue is expected to be small
 * (rare failures), and sequential delivery avoids bursting Telegram's
 * per-chat rate limit and keeps arrival order predictable. A message that
 * fails here does NOT block later ones from being attempted in the same
 * call — one permanently-undeliverable message (too long, invalid HTML)
 * must not silently freeze every message queued after it.
 */
export async function deliverPending(db: Kysely<Database>, config: TelegramConfig): Promise<DeliverPendingResult> {
  const pending = await db
    .selectFrom("pending_telegram_messages")
    .selectAll()
    .where("delivered_at", "is", null)
    .orderBy("created_at", "asc")
    .execute();

  let delivered = 0;
  let stillFailing = 0;

  for (const message of pending) {
    try {
      if (message.parse_mode === RICH_MARKDOWN_MARKER) {
        await sendRichMessage(config, message.message_text);
      } else {
        const options: SendAlertOptions | undefined =
          message.parse_mode === "HTML" || message.parse_mode === "Markdown"
            ? { parseMode: message.parse_mode }
            : undefined;
        await sendAlert(config, message.message_text, options);
      }
      await db
        .updateTable("pending_telegram_messages")
        .set({ delivered_at: new Date() })
        .where("id", "=", message.id)
        .execute();
      delivered++;
    } catch (e) {
      stillFailing++;
      const errorMessage = e instanceof Error ? e.message : String(e);
      await db
        .updateTable("pending_telegram_messages")
        .set({ attempts: message.attempts + 1, last_attempt_at: new Date(), last_error: errorMessage })
        .where("id", "=", message.id)
        .execute();
    }
  }

  return { delivered, stillFailing };
}
