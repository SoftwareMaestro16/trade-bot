/**
 * Long-polls Telegram's `getUpdates` for incoming kill-switch commands. This is
 * the second half of kill switch infrastructure's command intake — a file-flag
 * kill switch is being built in parallel elsewhere; this module is only
 * concerned with turning Telegram updates into `AuthorizedCommand`s.
 *
 * Bare `fetch` against the Bot API, same as telegram.ts and for the same
 * reason (see that file's header comment): no grammY/telegraf at this stage.
 *
 * Split into ./telegramPolling/ — this file is now a barrel re-export:
 * ./telegramPolling/updateParsing.ts (raw update -> command parsing) and
 * ./telegramPolling/loop.ts (long-poll HTTP mechanics, the option/handle
 * types, and the loop itself, including chat-authorization dispatch).
 */

export * from "./telegramPolling/loop.js";
