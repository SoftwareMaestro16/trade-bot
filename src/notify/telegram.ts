/**
 * Bare HTTPS calls to the Telegram Bot API via Node 22's global `fetch` — no
 * grammY/telegraf. That's a deliberate choice for this stage of the project
 * (this module needs exactly one outbound call and one inbound parse, which
 * doesn't justify a bot-framework dependency yet), not an oversight.
 */

export interface TelegramConfig {
  botToken: string;
  allowedChatId: string; // RR-33 (SRS.md): the single whitelisted chat_id.
  /** Overridable only so tests don't have to wait out the real default (see TELEGRAM_REQUEST_TIMEOUT_MS). */
  requestTimeoutMs?: number;
}

export interface SendAlertOptions {
  parseMode?: "Markdown" | "HTML";
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Owner's own request: "внедрить inline кнопки нажимать и делать действия" —
 * a plain data shape for Telegram's own `InlineKeyboardMarkup`
 * (https://core.telegram.org/bots/api#inlinekeyboardmarkup). `callbackData`
 * is deliberately a short bare string (no leading `/`, no args) — see
 * killswitch/buttonRouter.ts's own doc comment for the exact vocabulary and
 * why authorizeCommand can reuse it unmodified.
 */
export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface InlineKeyboardMarkup {
  /** Rows of buttons, top to bottom; each inner array is one row, left to right. */
  inlineKeyboard: InlineKeyboardButton[][];
}

function toWireKeyboard(markup: InlineKeyboardMarkup): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: markup.inlineKeyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  };
}

/**
 * Carries only what's safe to hand to a logger: the HTTP status and
 * Telegram's own `description` field. Never the request URL/config — the
 * URL embeds `config.botToken` (`.../bot<token>/sendMessage`), so this class
 * deliberately has no field that could carry it, even indirectly via a
 * stashed raw error/response object. Same discipline as BybitError in
 * src/exchange/errors.ts: don't trust an upstream `console.error(error)`
 * somewhere else in the stack to remember to redact.
 */
export class TelegramApiError extends Error {
  readonly httpStatus: number | undefined;
  readonly telegramDescription: string | undefined;

  constructor(
    message: string,
    extra?: { httpStatus?: number | undefined; telegramDescription?: string | undefined },
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.httpStatus = extra?.httpStatus;
    this.telegramDescription = extra?.telegramDescription;
  }
}

interface HasOk {
  ok: unknown;
  description?: unknown;
}

function isHasOk(e: unknown): e is HasOk {
  return typeof e === "object" && e !== null && "ok" in e;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Found 2026-08-07, same-day production incident: exchange/client.ts's
 * Bybit calls had no request timeout, a single stalled connection blocked
 * an entire collector cycle forever (see that file's own doc comment for
 * the full story), and telegramPolling/loop.ts's getUpdates call already
 * had its own fetchTimeoutMs specifically to prevent this. This file's own
 * outbound calls (postToTelegram, sendDocument) had the identical gap — a
 * bare `fetch()` with no AbortController, unnoticed until the sibling
 * incident prompted checking here too. Node's global `fetch` has no default
 * timeout of its own. A stalled Telegram call wouldn't crash anything (it's
 * just an unresolved promise), but it WOULD hang killswitch-listener.ts's
 * inFlightPersists.track()'d alert forever, which would hang shutdown()'s
 * drain() forever, and — more seriously — notify/notificationQueue.ts's
 * periodic 15-minute deliverPending retry (scheduleRepeating's own "run,
 * then wait, then run again" pattern) would never reach "run again" if one
 * delivery attempt got stuck — silently defeating the durable queue's whole
 * purpose the exact same way the settled-funding sweep got silently stuck.
 * 15s matches exchange/client.ts's own REQUEST_TIMEOUT_MS reasoning:
 * generous for what should normally be a sub-second API call, bounded
 * regardless.
 */
const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

/**
 * POSTs to a Telegram Bot API method and applies the shared failure-detection
 * discipline both `sendAlert` and `sendRichMessage` need: throw on network
 * failure, on any non-2xx HTTP response, AND on Telegram's own `ok: false`
 * shape (Telegram sometimes answers HTTP 200 with `ok:false` in the JSON
 * body — an HTTP-status-only check would silently swallow that). Never logs
 * or rethrows `url` itself, since it embeds `config.botToken`.
 */
async function postToTelegram(
  url: string,
  payload: unknown,
  methodNameForErrors: string,
  timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS,
): Promise<void> {
  // Same reasoning as telegramPolling/loop.ts's pollOnce: covers both the
  // fetch() call and the response.text() read below via the same signal —
  // a connection can stall mid-body-read just as easily as before the first
  // byte, and both must be bounded, not just the first.
  const abortController = new AbortController();
  const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });
  } catch (e) {
    clearTimeout(timeoutTimer);
    const message = abortController.signal.aborted
      ? `timed out after ${String(timeoutMs)}ms`
      : typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message
          : "unrecognized error shape";
    throw new TelegramApiError(`Telegram ${methodNameForErrors} network error: ${message}`);
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (e) {
    clearTimeout(timeoutTimer);
    const message = abortController.signal.aborted
      ? `timed out after ${String(timeoutMs)}ms (mid-body-read)`
      : typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message
          : "unrecognized error shape";
    throw new TelegramApiError(`Telegram ${methodNameForErrors} network error: ${message}`);
  }
  clearTimeout(timeoutTimer);
  const parsed = safeJsonParse(rawBody);
  const body = isHasOk(parsed) ? parsed : undefined;
  const description = body !== undefined && typeof body.description === "string" ? body.description : undefined;

  if (!response.ok) {
    throw new TelegramApiError(
      `Telegram ${methodNameForErrors} failed: HTTP ${response.status}${description ? `: ${description}` : ""}`,
      { httpStatus: response.status, telegramDescription: description },
    );
  }

  if (body !== undefined && body.ok === false) {
    throw new TelegramApiError(`Telegram ${methodNameForErrors} rejected: ${description ?? "unknown error"}`, {
      httpStatus: response.status,
      telegramDescription: description,
    });
  }
}

/** POSTs a single alert message to the configured chat. See `postToTelegram` for the shared failure discipline. */
export async function sendAlert(config: TelegramConfig, text: string, options?: SendAlertOptions): Promise<void> {
  const payload: {
    chat_id: string;
    text: string;
    parse_mode?: "Markdown" | "HTML";
    reply_markup?: ReturnType<typeof toWireKeyboard>;
  } = {
    chat_id: config.allowedChatId,
    text,
  };
  if (options?.parseMode) {
    payload.parse_mode = options.parseMode;
  }
  if (options?.replyMarkup) {
    payload.reply_markup = toWireKeyboard(options.replyMarkup);
  }
  await postToTelegram(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    payload,
    "sendMessage",
    config.requestTimeoutMs,
  );
}

/**
 * Bot API 10.1 (2026-06-11): `sendRichMessage` renders real block-level
 * formatting (tables, headings, lists, ...) client-side — a genuine step up
 * from `sendMessage`'s HTML/MarkdownV2 (bold/italic/code/pre/links only, no
 * table entity type exists there at all). Owner's own request: real tables
 * in the digest/status messages instead of monospace `<code>` blocks faking
 * alignment.
 *
 * Uses `rich_message.markdown` (a convenience field alongside the
 * lower-level `blocks` array — see grammyjs/types' `InputRichMessage`,
 * cross-checked against Telegram's own Bot API changelog since this project
 * doesn't take a grammY runtime dependency, ADR-002/this file's own header)
 * rather than hand-building `RichBlockTable`/`RichBlockTableCell` objects:
 * the formatter callers already produce a markdown string (same shape as
 * every other message in this codebase), and Telegram parses GFM-style
 * pipe tables out of it server-side. `text` here is that markdown string,
 * not the already-rendered table — this function does not reformat it.
 */
export async function sendRichMessage(config: TelegramConfig, markdown: string): Promise<void> {
  const payload = {
    chat_id: config.allowedChatId,
    rich_message: { markdown },
  };
  await postToTelegram(
    `https://api.telegram.org/bot${config.botToken}/sendRichMessage`,
    payload,
    "sendRichMessage",
    config.requestTimeoutMs,
  );
}

export interface EditMessageOptions {
  parseMode?: "Markdown" | "HTML";
  /** Pass an empty InlineKeyboardMarkup ({inlineKeyboard: []}) to clear the buttons on this message entirely; omit to leave the existing keyboard untouched. */
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Edits the text (and optionally the button row) of an already-sent
 * message in place — the menu/confirm-flow's own mechanism (see
 * killswitch/buttonRouter.ts) for turning "Stop new entries?" + [Yes]/[No]
 * into "✅ Stopped." with no buttons, without spamming a new message for
 * every tap. Always targets `config.allowedChatId`, same as every other
 * outbound call in this file (see sendAlert/sendRichMessage) — the message
 * being edited was sent to that chat in the first place, so `messageId`
 * alone (Telegram scopes message_id per chat) is enough to identify it.
 */
export async function editMessageText(
  config: TelegramConfig,
  messageId: number,
  text: string,
  options?: EditMessageOptions,
): Promise<void> {
  const payload: {
    chat_id: string;
    message_id: number;
    text: string;
    parse_mode?: "Markdown" | "HTML";
    reply_markup?: ReturnType<typeof toWireKeyboard>;
  } = {
    chat_id: config.allowedChatId,
    message_id: messageId,
    text,
  };
  if (options?.parseMode) {
    payload.parse_mode = options.parseMode;
  }
  if (options?.replyMarkup) {
    payload.reply_markup = toWireKeyboard(options.replyMarkup);
  }
  await postToTelegram(
    `https://api.telegram.org/bot${config.botToken}/editMessageText`,
    payload,
    "editMessageText",
    config.requestTimeoutMs,
  );
}

export interface AnswerCallbackQueryOptions {
  /** Short toast text shown to the tapping user. Omit for "just stop the loading spinner, no visible feedback." */
  text?: string;
  /** Show as a blocking alert dialog instead of a transient toast — reserved for something the user must acknowledge, not used by this codebase today. */
  showAlert?: boolean;
}

/**
 * MUST be called for every received callback_query, whether or not it led
 * to any action — Telegram shows the tapped button as an indefinite loading
 * spinner client-side until this is called (or ~a few seconds pass and it
 * gives up with its own "query is too old" toast), regardless of whether
 * this bot did anything with the tap. Never throws INTO the caller's own
 * dispatch flow if it fails — see buttonRouter.ts's caller for why a failed
 * answerCallbackQuery must not block the actual action from happening.
 */
export async function answerCallbackQuery(
  config: TelegramConfig,
  callbackQueryId: string,
  options?: AnswerCallbackQueryOptions,
): Promise<void> {
  const payload: { callback_query_id: string; text?: string; show_alert?: boolean } = {
    callback_query_id: callbackQueryId,
  };
  if (options?.text) {
    payload.text = options.text;
  }
  if (options?.showAlert) {
    payload.show_alert = options.showAlert;
  }
  await postToTelegram(
    `https://api.telegram.org/bot${config.botToken}/answerCallbackQuery`,
    payload,
    "answerCallbackQuery",
    config.requestTimeoutMs,
  );
}

export interface SendDocumentOptions {
  caption?: string;
}

/** Bot API's documented `sendDocument`-recognized file extensions this codebase actually produces reports as. */
function inferDocumentMimeType(filename: string): string {
  if (filename.endsWith(".csv")) return "text/csv";
  if (filename.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

/**
 * Shared response-interpretation tail between `postToTelegram` (JSON-body
 * methods) and `sendDocument` (multipart-body method below): once a request
 * has actually been sent, both cases finish identically — parse whatever
 * came back, then throw on a non-2xx HTTP status or on Telegram's own
 * `ok:false` body (same double-check `postToTelegram`'s own doc comment
 * explains: Telegram sometimes answers HTTP 200 with `ok:false`). Kept as
 * its own function, deliberately NOT merged into `postToTelegram` itself
 * (which stays untouched) — see `sendDocument`'s own doc comment for why
 * widening `postToTelegram` to also accept a multipart body would be
 * forcing a worse abstraction, not a cleaner one. Never logs or rethrows
 * `response.url` for the same token-safety reason `postToTelegram` never does.
 */
async function throwOnTelegramFailure(response: Response, methodNameForErrors: string): Promise<void> {
  const rawBody = await response.text();
  const parsed = safeJsonParse(rawBody);
  const body = isHasOk(parsed) ? parsed : undefined;
  const description = body !== undefined && typeof body.description === "string" ? body.description : undefined;

  if (!response.ok) {
    throw new TelegramApiError(
      `Telegram ${methodNameForErrors} failed: HTTP ${response.status}${description ? `: ${description}` : ""}`,
      { httpStatus: response.status, telegramDescription: description },
    );
  }

  if (body !== undefined && body.ok === false) {
    throw new TelegramApiError(`Telegram ${methodNameForErrors} rejected: ${description ?? "unknown error"}`, {
      httpStatus: response.status,
      telegramDescription: description,
    });
  }
}

/**
 * POSTs a file to Telegram's `sendDocument` method — the one method in this
 * file that CANNOT go through `postToTelegram`: every other method here
 * (`sendMessage`, `sendRichMessage`) takes a JSON body, but Bot API's file
 * upload methods require actual `multipart/form-data` (a `chat_id` field
 * plus a `document` file part) — there is no JSON-encoded way to upload
 * file bytes to this endpoint. Rather than bend `postToTelegram`'s
 * `payload: unknown` + `JSON.stringify(payload)` shape to also cover a
 * pre-built multipart body (which would leave every JSON caller carrying a
 * branch it never takes, for the sake of one caller that needs a
 * completely different request shape), this function builds and sends its
 * own multipart request and then reuses `throwOnTelegramFailure` for just
 * the response-interpretation half both cases genuinely share.
 *
 * Bare `fetch`/`FormData`/`Blob` — all native in Node 22, no grammY, same as
 * every other request in this file (see this file's own header comment).
 * `content` is written to the multipart part as-is; this function performs
 * no encoding/formatting of it (the caller — e.g.
 * `emulation/reportGenerator.ts` — is responsible for producing the exact
 * bytes, e.g. a UTF-8-BOM-prefixed CSV, it wants Telegram to receive).
 * Never logs or throws the request URL, since it embeds `config.botToken`
 * — same discipline as `postToTelegram`/`TelegramApiError`.
 */
export async function sendDocument(
  config: TelegramConfig,
  filename: string,
  content: string,
  options?: SendDocumentOptions,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", config.allowedChatId);
  form.append("document", new Blob([content], { type: inferDocumentMimeType(filename) }), filename);
  if (options?.caption) {
    form.append("caption", options.caption);
  }

  // Same TELEGRAM_REQUEST_TIMEOUT_MS/AbortController treatment as
  // postToTelegram (see that constant's own doc comment) — the signal
  // covers throwOnTelegramFailure's own response.text() read below too,
  // same as it does for postToTelegram's inline equivalent.
  const timeoutMs = config.requestTimeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: abortController.signal,
    });
  } catch (e) {
    clearTimeout(timeoutTimer);
    const message = abortController.signal.aborted
      ? `timed out after ${String(timeoutMs)}ms`
      : typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message
          : "unrecognized error shape";
    throw new TelegramApiError(`Telegram sendDocument network error: ${message}`);
  }

  try {
    await throwOnTelegramFailure(response, "sendDocument");
  } catch (e) {
    // throwOnTelegramFailure's own response.text() can itself be the thing
    // that stalls (headers arrived, body didn't) — its rejection on abort is
    // a raw AbortError, not yet a TelegramApiError, so it's normalized here
    // rather than left to leak an unnormalized shape to the caller.
    if (e instanceof TelegramApiError) throw e;
    clearTimeout(timeoutTimer);
    const message = abortController.signal.aborted
      ? `timed out after ${String(timeoutMs)}ms (mid-body-read)`
      : e instanceof Error
        ? e.message
        : "unrecognized error shape";
    throw new TelegramApiError(`Telegram sendDocument network error: ${message}`);
  }
  clearTimeout(timeoutTimer);
}

export interface IncomingCommand {
  chatId: string;
  text: string;
}

export type AuthorizedCommand =
  | { authorized: true; chatId: string; command: string; args: string[] }
  | { authorized: false; rejectedChatId: string };

/**
 * Answers "is this chat_id allowed to issue kill-switch commands at all?".
 * Injected by the caller rather than this module reaching for a single
 * hardcoded chat_id itself — this module has no notion of "root admin" or
 * "additional authorized users via a DB table"; that policy lives entirely
 * with whoever constructs the predicate (killswitch-listener.ts's
 * isAuthorizedChat). `chatId` is always the raw string off the wire — see
 * authorizeCommand's own doc comment for why comparisons must never coerce
 * through Number().
 */
export type ChatAuthorizer = (chatId: string) => Promise<boolean>;

/**
 * RR-33 (SRS.md, verbatim): "Команды Telegram принимаются только от одного
 * chat_id из белого списка. Все прочие отвергаются и логируются." Originally
 * that whitelist was a single hardcoded chat_id compared directly against
 * `TelegramConfig.allowedChatId`; it has since grown to "root admin + a DB
 * table of additionally authorized chat_ids" (killswitch-listener.ts), so
 * this function no longer owns that comparison itself — it delegates to the
 * injected `isAuthorized` predicate and stays pure otherwise (no logging, no
 * I/O of its own beyond awaiting the predicate it was handed). `chatId` is
 * passed to the predicate as a plain string, never coerced through Number():
 * group chat_ids are negative, and string equality is the only comparison
 * that can't be fooled by numeric-format quirks (e.g. "007" vs "7" are equal
 * numerically but must NOT be treated as the same chat).
 *
 * RR-33's other half — that rejected attempts are logged — is NOT done here.
 * The caller MUST log every `{ authorized: false, rejectedChatId }` result
 * this function returns; skipping that silently breaks RR-33 even though the
 * rejection itself still works correctly.
 */
export async function authorizeCommand(
  isAuthorized: ChatAuthorizer,
  incoming: IncomingCommand,
): Promise<AuthorizedCommand> {
  if (!(await isAuthorized(incoming.chatId))) {
    return { authorized: false, rejectedChatId: incoming.chatId };
  }

  const trimmed = incoming.text.trim();
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const parts = withoutSlash.split(/\s+/).filter((part) => part.length > 0);

  return { authorized: true, chatId: incoming.chatId, command: parts[0] ?? "", args: parts.slice(1) };
}
