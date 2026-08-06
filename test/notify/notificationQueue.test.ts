import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { deliverPending, enqueueNotification, enqueueRichNotification } from "../../src/notify/notificationQueue.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";
import type { TelegramConfig } from "../../src/notify/telegram.js";

const TELEGRAM_BASE = "https://api.telegram.org";
const FAKE_TOKEN = "123456:FAKE_QUEUE_TEST_TOKEN";
const config: TelegramConfig = { botToken: FAKE_TOKEN, allowedChatId: "555000111" };

afterEach(() => nock.cleanAll());

describe("notificationQueue (against a real local Postgres, mocked Telegram)", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });
  afterEach(async () => {
    await db.deleteFrom("pending_telegram_messages").execute();
  });
  afterAll(async () => db.destroy());

  it("enqueueNotification writes a row that deliverPending later finds and delivers", async () => {
    await enqueueNotification(db, "test digest message", { parseMode: "HTML" });

    const rows = await db.selectFrom("pending_telegram_messages").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_text).toBe("test digest message");
    expect(rows[0]?.parse_mode).toBe("HTML");
    expect(rows[0]?.delivered_at).toBeNull();

    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "test digest message", parse_mode: "HTML" })
      .reply(200, { ok: true, result: { message_id: 1 } });

    const result = await deliverPending(db, config);
    expect(result).toEqual({ delivered: 1, stillFailing: 0 });
    expect(scope.isDone()).toBe(true);

    const after = await db.selectFrom("pending_telegram_messages").selectAll().execute();
    expect(after[0]?.delivered_at).not.toBeNull();
  });

  it("a message with no parseMode round-trips as parse_mode=NULL, and delivers with no parse_mode in the request", async () => {
    await enqueueNotification(db, "plain text alert");

    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "plain text alert" })
      .reply(200, { ok: true, result: { message_id: 2 } });

    const result = await deliverPending(db, config);
    expect(result).toEqual({ delivered: 1, stillFailing: 0 });
    expect(scope.isDone()).toBe(true);
  });

  it("a still-failing message is NOT marked delivered, gets attempts/last_error recorded, and does not block a later message in the same batch from delivering", async () => {
    await enqueueNotification(db, "first — will fail again");
    await enqueueNotification(db, "second — will succeed");

    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "first — will fail again" })
      .reply(500, { ok: false, description: "Internal Server Error" });
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "second — will succeed" })
      .reply(200, { ok: true, result: { message_id: 3 } });

    const result = await deliverPending(db, config);
    expect(result).toEqual({ delivered: 1, stillFailing: 1 });

    const rows = await db.selectFrom("pending_telegram_messages").selectAll().orderBy("created_at", "asc").execute();
    expect(rows[0]?.message_text).toBe("first — will fail again");
    expect(rows[0]?.delivered_at).toBeNull();
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.last_error).toContain("500");

    expect(rows[1]?.message_text).toBe("second — will succeed");
    expect(rows[1]?.delivered_at).not.toBeNull();
  });

  it("already-delivered messages are never re-attempted on a later deliverPending call", async () => {
    await enqueueNotification(db, "delivered already");
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "delivered already" })
      .reply(200, { ok: true, result: { message_id: 4 } });
    await deliverPending(db, config);

    // No nock interceptor registered for this second call — if deliverPending
    // tried to re-send the already-delivered message, this would fail with a
    // real "no match" error from nock, not silently pass.
    const result = await deliverPending(db, config);
    expect(result).toEqual({ delivered: 0, stillFailing: 0 });
  });

  it("delivers in oldest-first order, matching how a reader would expect them to arrive", async () => {
    await enqueueNotification(db, "oldest");
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure distinct created_at ordering
    await enqueueNotification(db, "newest");

    const order: string[] = [];
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, (body: { text?: string }) => {
        if (body.text) order.push(body.text);
        return true;
      })
      .times(2)
      .reply(200, { ok: true, result: { message_id: 5 } });

    await deliverPending(db, config);
    expect(order).toEqual(["oldest", "newest"]);
  });

  it("enqueueRichNotification delivers via sendRichMessage (Bot API 10.1), not sendMessage", async () => {
    await enqueueRichNotification(db, "| a | b |\n|---|---|\n| 1 | 2 |");

    const rows = await db.selectFrom("pending_telegram_messages").selectAll().execute();
    expect(rows[0]?.parse_mode).toBe("rich_markdown");

    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendRichMessage`, {
        chat_id: config.allowedChatId,
        rich_message: { markdown: "| a | b |\n|---|---|\n| 1 | 2 |" },
      })
      .reply(200, { ok: true, result: {} });

    const result = await deliverPending(db, config);
    expect(result).toEqual({ delivered: 1, stillFailing: 0 });
    expect(scope.isDone()).toBe(true);
  });

  it("a mixed batch routes each message to the right Telegram method by its own parse_mode", async () => {
    await enqueueNotification(db, "plain text alert");
    await enqueueRichNotification(db, "| table |");

    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "plain text alert" })
      .reply(200, { ok: true, result: {} });
    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendRichMessage`, { chat_id: config.allowedChatId, rich_message: { markdown: "| table |" } })
      .reply(200, { ok: true, result: {} });

    const result = await deliverPending(db, config);
    expect(result).toEqual({ delivered: 2, stillFailing: 0 });
  });
});
