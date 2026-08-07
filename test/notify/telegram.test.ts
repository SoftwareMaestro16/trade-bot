import nock from "nock";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerCallbackQuery,
  authorizeCommand,
  editMessageText,
  sendAlert,
  sendDocument,
  sendRichMessage,
  TelegramApiError,
} from "../../src/notify/telegram.js";
import type { ChatAuthorizer, InlineKeyboardMarkup, TelegramConfig } from "../../src/notify/telegram.js";

const TELEGRAM_BASE = "https://api.telegram.org";
// Deliberately eye-catching so a leak into an error's message/stack/serialized
// form is impossible to miss in the assertions below.
const FAKE_TOKEN = "123456:FAKE_SECRET_TOKEN_XYZ";

const config: TelegramConfig = {
  botToken: FAKE_TOKEN,
  allowedChatId: "555000111",
};

afterEach(() => {
  nock.cleanAll();
});

describe("sendAlert", () => {
  it("POSTs chat_id and text to Telegram's sendMessage endpoint", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "position closed" })
      .reply(200, { ok: true, result: { message_id: 1 } });

    await expect(sendAlert(config, "position closed")).resolves.toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("includes parse_mode in the request body when passed", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, {
        chat_id: config.allowedChatId,
        text: "*bold*",
        parse_mode: "Markdown",
      })
      .reply(200, { ok: true, result: { message_id: 2 } });

    await expect(sendAlert(config, "*bold*", { parseMode: "Markdown" })).resolves.toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("includes reply_markup, translated from camelCase inlineKeyboard/callbackData to Telegram's wire snake_case, when passed", async () => {
    const keyboard: InlineKeyboardMarkup = {
      inlineKeyboard: [
        [{ text: "📊 Статус", callbackData: "status" }, { text: "❓ Помощь", callbackData: "help" }],
        [{ text: "🛑 Stop", callbackData: "stop_confirm" }],
      ],
    };
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, {
        chat_id: config.allowedChatId,
        text: "Быстрые действия:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 Статус", callback_data: "status" }, { text: "❓ Помощь", callback_data: "help" }],
            [{ text: "🛑 Stop", callback_data: "stop_confirm" }],
          ],
        },
      })
      .reply(200, { ok: true, result: { message_id: 4 } });

    await expect(sendAlert(config, "Быстрые действия:", { replyMarkup: keyboard })).resolves.toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("rejects with TelegramApiError on HTTP 500, and never leaks the bot token", async () => {
    nock(TELEGRAM_BASE).post(`/bot${FAKE_TOKEN}/sendMessage`).reply(500, "Internal Server Error");

    let caught: unknown;
    try {
      await sendAlert(config, "alert text");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.httpStatus).toBe(500);

    // Same discipline as test/exchange/errors.test.ts's RR-03 check: the
    // secret must not be reachable anywhere off the thrown error.
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.stack ?? "").not.toContain(FAKE_TOKEN);
  });

  it("carries Telegram's description through on a non-2xx JSON error body, still without the token", async () => {
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`)
      .reply(401, { ok: false, error_code: 401, description: "Unauthorized" });

    let caught: unknown;
    try {
      await sendAlert(config, "alert text");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.httpStatus).toBe(401);
    expect(err.telegramDescription).toBe("Unauthorized");

    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it("rejects with TelegramApiError when Telegram answers HTTP 200 with ok:false", async () => {
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`)
      .reply(200, { ok: false, error_code: 400, description: "Bad Request: chat not found" });

    let caught: unknown;
    try {
      await sendAlert(config, "alert text");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.telegramDescription).toBe("Bad Request: chat not found");

    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });
});

describe("sendRichMessage (Bot API 10.1)", () => {
  it("POSTs chat_id and rich_message.markdown to the sendRichMessage endpoint, not sendMessage", () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendRichMessage`, {
        chat_id: config.allowedChatId,
        rich_message: { markdown: "| a | b |\n|---|---|\n| 1 | 2 |" },
      })
      .reply(200, { ok: true, result: {} });

    return sendRichMessage(config, "| a | b |\n|---|---|\n| 1 | 2 |").then(() => {
      expect(scope.isDone()).toBe(true);
    });
  });

  it("rejects with TelegramApiError on HTTP 500, and never leaks the bot token", async () => {
    nock(TELEGRAM_BASE).post(`/bot${FAKE_TOKEN}/sendRichMessage`).reply(500, "Internal Server Error");

    let caught: unknown;
    try {
      await sendRichMessage(config, "| a | b |");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.httpStatus).toBe(500);
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it("rejects with TelegramApiError when Telegram answers HTTP 200 with ok:false", async () => {
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendRichMessage`)
      .reply(200, { ok: false, error_code: 400, description: "Bad Request: can't parse rich_message" });

    let caught: unknown;
    try {
      await sendRichMessage(config, "| broken |");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    expect((caught as TelegramApiError).telegramDescription).toBe("Bad Request: can't parse rich_message");
  });
});

describe("sendDocument (multipart/form-data, not JSON)", () => {
  // Node's fetch (undici) generates the multipart boundary itself, so an
  // exact-body match (the way sendAlert/sendRichMessage match an exact JSON
  // object above) isn't possible — instead assert the raw multipart body
  // CONTAINS every field/value it must carry.
  function multipartBodyContains(...needles: string[]): (body: unknown) => boolean {
    return (body: unknown) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return needles.every((needle) => text.includes(needle));
    };
  }

  it("POSTs chat_id and the document's filename/content as multipart/form-data to sendDocument, not sendMessage", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(
        `/bot${FAKE_TOKEN}/sendDocument`,
        multipartBodyContains(
          'name="chat_id"',
          config.allowedChatId,
          'name="document"; filename="paper_summary_run1.md"',
          "# Paper-trading report",
        ),
      )
      .reply(200, { ok: true, result: { message_id: 3 } });

    await expect(
      sendDocument(config, "paper_summary_run1.md", "# Paper-trading report\n\n| a | b |\n"),
    ).resolves.toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("includes a caption field when passed", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendDocument`, multipartBodyContains('name="caption"', "run1 results"))
      .reply(200, { ok: true, result: {} });

    await sendDocument(config, "paper_trades_run1.csv", "a,b\r\n1,2\r\n", { caption: "run1 results" });
    expect(scope.isDone()).toBe(true);
  });

  it("rejects with TelegramApiError on HTTP 500, and never leaks the bot token", async () => {
    nock(TELEGRAM_BASE).post(`/bot${FAKE_TOKEN}/sendDocument`).reply(500, "Internal Server Error");

    let caught: unknown;
    try {
      await sendDocument(config, "paper_trades_run1.csv", "a,b\r\n1,2\r\n");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.httpStatus).toBe(500);

    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.stack ?? "").not.toContain(FAKE_TOKEN);
  });

  it("carries Telegram's description through on a non-2xx JSON error body, still without the token", async () => {
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendDocument`)
      .reply(400, { ok: false, error_code: 400, description: "Bad Request: file must be non-empty" });

    let caught: unknown;
    try {
      await sendDocument(config, "empty.csv", "");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.httpStatus).toBe(400);
    expect(err.telegramDescription).toBe("Bad Request: file must be non-empty");

    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it("rejects with TelegramApiError when Telegram answers HTTP 200 with ok:false", async () => {
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendDocument`)
      .reply(200, { ok: false, error_code: 400, description: "Bad Request: chat not found" });

    let caught: unknown;
    try {
      await sendDocument(config, "paper_summary_run1.md", "# report");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const err = caught as TelegramApiError;
    expect(err.telegramDescription).toBe("Bad Request: chat not found");

    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it("rejects with TelegramApiError on a network failure, never leaking the token", async () => {
    nock(TELEGRAM_BASE).post(`/bot${FAKE_TOKEN}/sendDocument`).replyWithError("connection reset");

    let caught: unknown;
    try {
      await sendDocument(config, "paper_summary_run1.md", "# report");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });
});

describe("editMessageText", () => {
  it("POSTs chat_id, message_id and text to editMessageText", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/editMessageText`, {
        chat_id: config.allowedChatId,
        message_id: 42,
        text: "✅ HALT_NEW включён.",
      })
      .reply(200, { ok: true, result: {} });

    await expect(editMessageText(config, 42, "✅ HALT_NEW включён.")).resolves.toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("includes an empty reply_markup.inline_keyboard when passed an empty InlineKeyboardMarkup (clears the buttons)", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/editMessageText`, {
        chat_id: config.allowedChatId,
        message_id: 42,
        text: "done",
        reply_markup: { inline_keyboard: [] },
      })
      .reply(200, { ok: true, result: {} });

    await editMessageText(config, 42, "done", { replyMarkup: { inlineKeyboard: [] } });
    expect(scope.isDone()).toBe(true);
  });

  it("includes parse_mode when passed", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/editMessageText`, {
        chat_id: config.allowedChatId,
        message_id: 7,
        text: "<b>bold</b>",
        parse_mode: "HTML",
      })
      .reply(200, { ok: true, result: {} });

    await editMessageText(config, 7, "<b>bold</b>", { parseMode: "HTML" });
    expect(scope.isDone()).toBe(true);
  });

  it("rejects with TelegramApiError on HTTP 500, and never leaks the bot token", async () => {
    nock(TELEGRAM_BASE).post(`/bot${FAKE_TOKEN}/editMessageText`).reply(500, "Internal Server Error");

    let caught: unknown;
    try {
      await editMessageText(config, 1, "text");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });
});

describe("answerCallbackQuery", () => {
  it("POSTs only callback_query_id when no options are given", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/answerCallbackQuery`, { callback_query_id: "cbq-1" })
      .reply(200, { ok: true, result: true });

    await expect(answerCallbackQuery(config, "cbq-1")).resolves.toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("includes text (toast) and show_alert when passed", async () => {
    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/answerCallbackQuery`, {
        callback_query_id: "cbq-2",
        text: "Остановлено",
        show_alert: true,
      })
      .reply(200, { ok: true, result: true });

    await answerCallbackQuery(config, "cbq-2", { text: "Остановлено", showAlert: true });
    expect(scope.isDone()).toBe(true);
  });

  it("rejects with TelegramApiError on HTTP 500, and never leaks the bot token", async () => {
    nock(TELEGRAM_BASE).post(`/bot${FAKE_TOKEN}/answerCallbackQuery`).reply(500, "Internal Server Error");

    let caught: unknown;
    try {
      await answerCallbackQuery(config, "cbq-3");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TelegramApiError);
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized).not.toContain(FAKE_TOKEN);
  });
});

describe("authorizeCommand", () => {
  // A stand-in ChatAuthorizer, not killswitch/authorizedUsers.ts's real
  // isAuthorizedChat (that has its own DB-backed tests) — authorizeCommand
  // itself must stay agnostic to WHERE the predicate's answer comes from, so
  // these tests only ever assert on the predicate's return value / call args.
  const alwaysAuthorized: ChatAuthorizer = () => Promise.resolve(true);
  const neverAuthorized: ChatAuthorizer = () => Promise.resolve(false);

  it("authorizes when the predicate resolves true, and parses a bare command", async () => {
    const result = await authorizeCommand(alwaysAuthorized, { chatId: "-100123456", text: "/stop" });
    expect(result).toEqual({ authorized: true, chatId: "-100123456", command: "stop", args: [] });
  });

  it("rejects when the predicate resolves false, reporting the rejected chat_id for the caller to log", async () => {
    const result = await authorizeCommand(neverAuthorized, { chatId: "999", text: "/stop" });
    expect(result).toEqual({ authorized: false, rejectedChatId: "999" });
  });

  it("calls the predicate with exactly incoming.chatId, as a plain string (RR-33: no Number() coercion)", async () => {
    const isAuthorized = vi.fn(alwaysAuthorized);
    // "007" as the incoming chat_id: if this were ever coerced through
    // Number() anywhere between IncomingCommand and the predicate, the
    // predicate would observe "7" instead — this pins down that it doesn't.
    await authorizeCommand(isAuthorized, { chatId: "007", text: "/stop" });
    expect(isAuthorized).toHaveBeenCalledTimes(1);
    expect(isAuthorized).toHaveBeenCalledWith("007");
  });

  it("parses a command with multiple arguments", async () => {
    const result = await authorizeCommand(alwaysAuthorized, { chatId: "-100123456", text: "/status arg1 arg2" });
    expect(result).toEqual({ authorized: true, chatId: "-100123456", command: "status", args: ["arg1", "arg2"] });
  });

  it("still authorizes text with no leading slash, parsing the first word as the command", async () => {
    const result = await authorizeCommand(alwaysAuthorized, { chatId: "-100123456", text: "hello world" });
    expect(result).toEqual({ authorized: true, chatId: "-100123456", command: "hello", args: ["world"] });
  });
});
