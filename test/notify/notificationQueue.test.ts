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

interface ThrowingUpdateBuilder {
  set: () => ThrowingUpdateBuilder;
  where: () => ThrowingUpdateBuilder;
  execute: () => Promise<never>;
}

/**
 * Wraps a REAL Kysely db so that the Nth call `deliverPending` makes to
 * `.updateTable(...)` throws instead of reaching Postgres — every other call
 * (including later `updateTable` calls, and everything used by the test
 * itself to set up/verify rows) goes straight through to the real
 * connection. Models a DB hiccup landing on exactly one write mid-loop (e.g.
 * a dropped connection right after Telegram already accepted the message) —
 * not a dead Telegram integration, not a permanently-dead DB.
 */
function dbWhereNthUpdateThrows(realDb: Kysely<Database>, n: number, errorMessage: string): Kysely<Database> {
  let updateCalls = 0;
  const originalUpdateTable = realDb.updateTable.bind(realDb);
  return new Proxy(realDb, {
    get(target, prop) {
      if (prop === "updateTable") {
        return (...args: Parameters<Kysely<Database>["updateTable"]>) => {
          updateCalls++;
          if (updateCalls === n) {
            // Explicitly typed (rather than let TS infer it from the object
            // literal) because `set`/`where` return `thrower` itself — an
            // un-annotated self-referential initializer like this is exactly
            // the pattern TS7022 rejects under strict/noImplicitAny.
            const thrower: ThrowingUpdateBuilder = {
              set: () => thrower,
              where: () => thrower,
              execute: async () => {
                throw new Error(errorMessage);
              },
            };
            return thrower;
          }
          return originalUpdateTable(...args);
        };
      }
      // Every other property (selectFrom, insertInto, deleteFrom, destroy, ...)
      // passes straight through to the real Kysely instance. Bound to `target`
      // (not `receiver`, i.e. not this Proxy) because Kysely keeps its actual
      // connection/executor in real `#private` class fields — a method call
      // with `this` pointing at the Proxy instead of the real instance would
      // throw ("Cannot read private member from an object whose class did not
      // declare it") the moment it touched one.
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
}

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

  it("Telegram send succeeds but the delivered_at write fails (e.g. a DB hiccup right after): counted as delivered, NOT recorded as a send failure", async () => {
    await enqueueNotification(db, "sent ok, bookkeeping write drops");

    const scope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "sent ok, bookkeeping write drops" })
      .reply(200, { ok: true, result: { message_id: 20 } });

    // The 1st updateTable call in this run is the delivered_at write for this
    // message (there's only one message, so it can't be anything else) — make
    // exactly that one throw, simulating a DB connection dropping right after
    // Telegram already accepted the message.
    const flakyDb = dbWhereNthUpdateThrows(db, 1, "simulated connection drop right after Telegram accepted the message");

    const result = await deliverPending(flakyDb, config);
    expect(scope.isDone()).toBe(true); // Telegram really did receive it — a resend next cycle would be a real duplicate

    // Counted as delivered: the send genuinely succeeded, so this must not be
    // reported (or, via last_error below, logged) as a Telegram failure.
    expect(result).toEqual({ delivered: 1, stillFailing: 0 });

    const row = await db.selectFrom("pending_telegram_messages").selectAll().executeTakeFirstOrThrow();
    // delivered_at could not be persisted — the accepted, documented cost of
    // this failure mode (the next deliverPending call will resend it).
    expect(row.delivered_at).toBeNull();
    // But NOT run through the send-failure bookkeeping path: attempts/last_error
    // must stay untouched, or a human reading this row later would wrongly
    // conclude Telegram rejected a message it actually already has.
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it("a send failure AND the resulting attempts/last_error write both fail: the loop still reaches the next queued message in the same call", async () => {
    await enqueueNotification(db, "first — send fails, then its own bookkeeping write fails too");
    await enqueueNotification(db, "second — must still be attempted in this same call");

    nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, {
        chat_id: config.allowedChatId,
        text: "first — send fails, then its own bookkeeping write fails too",
      })
      .reply(500, { ok: false, description: "Internal Server Error" });
    const secondScope = nock(TELEGRAM_BASE)
      .post(`/bot${FAKE_TOKEN}/sendMessage`, { chat_id: config.allowedChatId, text: "second — must still be attempted in this same call" })
      .reply(200, { ok: true, result: { message_id: 21 } });

    // The 1st updateTable call in this run is the failed-attempt bookkeeping
    // update for message #1 (it never reaches a delivered_at update — sendAlert
    // throws first). Making exactly that one throw too puts BOTH writes for
    // message #1 in the failed state a real total DB outage would cause —
    // without a nested try/catch around it, this exception used to escape
    // deliverPending entirely and message #2 was never even attempted (its nock
    // interceptor would be left unconsumed and the whole call would reject).
    const flakyDb = dbWhereNthUpdateThrows(db, 1, "simulated total DB outage");

    const result = await deliverPending(flakyDb, config);
    expect(result).toEqual({ delivered: 1, stillFailing: 1 });
    expect(secondScope.isDone()).toBe(true); // proof the loop actually reached message #2

    const rows = await db.selectFrom("pending_telegram_messages").selectAll().orderBy("created_at", "asc").execute();
    expect(rows[0]?.message_text).toContain("first");
    expect(rows[0]?.delivered_at).toBeNull();
    // The failed-attempt write also failed this cycle — attempts/last_error
    // simply couldn't advance; that's the accepted cost, not a crash.
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.last_error).toBeNull();

    expect(rows[1]?.message_text).toContain("second");
    expect(rows[1]?.delivered_at).not.toBeNull(); // second message delivered normally, unaffected by the first's failure
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
