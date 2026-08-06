import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeCommand, sendAlert, sendDocument, sendRichMessage, TelegramApiError } from "../../src/notify/telegram.js";
import type { TelegramConfig } from "../../src/notify/telegram.js";

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

describe("authorizeCommand", () => {
  const groupConfig: TelegramConfig = { botToken: FAKE_TOKEN, allowedChatId: "-100123456" };

  it("authorizes on an exact chat_id match, including a negative group chat_id, and parses a bare command", () => {
    const result = authorizeCommand(groupConfig, { chatId: "-100123456", text: "/stop" });
    expect(result).toEqual({ authorized: true, command: "stop", args: [] });
  });

  it("rejects when chat_id does not match, reporting the rejected chat_id for the caller to log", () => {
    const result = authorizeCommand(groupConfig, { chatId: "999", text: "/stop" });
    expect(result).toEqual({ authorized: false, rejectedChatId: "999" });
  });

  it("compares chat_id as strings, not numbers (RR-33: no Number() coercion)", () => {
    const strictConfig: TelegramConfig = { botToken: FAKE_TOKEN, allowedChatId: "007" };
    // "007" !== "7" as strings, even though Number("007") === Number("7").
    const result = authorizeCommand(strictConfig, { chatId: "7", text: "/stop" });
    expect(result).toEqual({ authorized: false, rejectedChatId: "7" });
  });

  it("parses a command with multiple arguments", () => {
    const result = authorizeCommand(groupConfig, { chatId: "-100123456", text: "/status arg1 arg2" });
    expect(result).toEqual({ authorized: true, command: "status", args: ["arg1", "arg2"] });
  });

  it("still authorizes text with no leading slash, parsing the first word as the command", () => {
    const result = authorizeCommand(groupConfig, { chatId: "-100123456", text: "hello world" });
    expect(result).toEqual({ authorized: true, command: "hello", args: ["world"] });
  });
});
