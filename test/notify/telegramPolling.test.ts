import nock from "nock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCommandPolling } from "../../src/notify/telegramPolling.js";
import type { TelegramPollingHandle } from "../../src/notify/telegramPolling.js";
import type { ChatAuthorizer, TelegramConfig } from "../../src/notify/telegram.js";

const TELEGRAM_BASE = "https://api.telegram.org";
// Deliberately eye-catching, same convention as test/notify/telegram.test.ts,
// so a leak into console.error is impossible to miss in the assertions below.
const FAKE_TOKEN = "123456:FAKE_POLLING_TOKEN";
const GET_UPDATES_PATH = `/bot${FAKE_TOKEN}/getUpdates`;

const config: TelegramConfig = {
  botToken: FAKE_TOKEN,
  allowedChatId: "555000111",
};

// Stand-in ChatAuthorizer mirroring the pre-refactor single-chat_id
// whitelist — this file tests startCommandPolling's own plumbing (offset
// tracking, error backoff, stop() semantics, awaiting authorizeCommand
// before calling onCommand), not authorization policy itself (that's
// test/notify/telegram.test.ts's authorizeCommand suite and
// test/killswitch/authorizedUsers.test.ts's DB-backed suite).
const isAuthorizedChat: ChatAuthorizer = (chatId) => Promise.resolve(chatId === config.allowedChatId);

function updatesReply(result: unknown[]): { ok: true; result: unknown[] } {
  return { ok: true, result };
}

/**
 * Registers a low-priority, indefinitely-reusable interceptor that quietly
 * answers "no updates" to any getUpdates call. nock tries interceptors in
 * registration order, so calling this AFTER a test's specific scope(s) never
 * steals a match from them — it only catches whatever the loop naturally
 * attempts next while racing a same-tick handle.stop() at the end of a test.
 * Without this, that race is still harmless (stop() always wins within at
 * most one more round-trip), just noisy: an unmocked call makes nock reject
 * it, which is real behavior worth keeping out of every test that isn't
 * specifically about that (test 6 below is, and skips this on purpose).
 */
function mockQuietTail(): void {
  nock(TELEGRAM_BASE).get(GET_UPDATES_PATH).query(true).reply(200, updatesReply([])).persist();
}

// Deliberately real timers throughout this file, not vi.useFakeTimers().
// startCommandPolling's loop re-polls via a real setTimeout/Promise chain,
// and nock's fetch/undici interception delivers even a mocked response
// through genuine microtask + setImmediate hops it owns, not this module —
// vitest's fake-timer "Async" helpers only bound-await the timer callback
// they fire, not whatever further real async work that callback goes on to
// trigger, so they can't stand in for actually letting a mocked HTTP
// round-trip complete. vi.waitFor polls for real, which sidesteps the whole
// problem, and every getUpdates round-trip here is in-memory (nock) and near
// instant, so this doesn't slow the suite down in practice.
afterEach(() => {
  nock.cleanAll();
});

describe("startCommandPolling", () => {
  it("delivers every update from a single getUpdates response to onCommand, correctly parsed", async () => {
    const scope = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query(true)
      .reply(
        200,
        updatesReply([
          { update_id: 10, message: { chat: { id: 555000111 }, text: "/status" } },
          { update_id: 11, message: { chat: { id: 555000111 }, text: "/stop now please" } },
        ]),
      );
    mockQuietTail();

    const onCommand = vi.fn();
    const handle = startCommandPolling(config, isAuthorizedChat, onCommand);

    await vi.waitFor(() => {
      expect(onCommand).toHaveBeenCalledTimes(2);
    });

    expect(scope.isDone()).toBe(true);
    expect(onCommand).toHaveBeenNthCalledWith(1, {
      authorized: true,
      chatId: "555000111",
      command: "status",
      args: [],
    });
    expect(onCommand).toHaveBeenNthCalledWith(2, {
      authorized: true,
      chatId: "555000111",
      command: "stop",
      args: ["now", "please"],
    });

    void handle.stop();
  });

  it("still delivers a rejected command to onCommand, for the caller to log (RR-33) — authorizeCommand itself does not log", async () => {
    const scope = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query(true)
      .reply(
        200,
        updatesReply([
          { update_id: 20, message: { chat: { id: 555000111 }, text: "/status" } },
          { update_id: 21, message: { chat: { id: 999999999 }, text: "/status" } }, // stranger chat_id
        ]),
      );
    mockQuietTail();

    const onCommand = vi.fn();
    const handle = startCommandPolling(config, isAuthorizedChat, onCommand);

    await vi.waitFor(() => {
      expect(onCommand).toHaveBeenCalledTimes(2);
    });

    expect(scope.isDone()).toBe(true);
    expect(onCommand).toHaveBeenNthCalledWith(1, {
      authorized: true,
      chatId: "555000111",
      command: "status",
      args: [],
    });
    expect(onCommand).toHaveBeenNthCalledWith(2, { authorized: false, rejectedChatId: "999999999" });

    void handle.stop();
  });

  it("skips an update with no message.text (e.g. my_chat_member) without calling onCommand, but still advances offset past it", async () => {
    const scope1 = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query({ timeout: "30" })
      .reply(
        200,
        updatesReply([{ update_id: 5, my_chat_member: { chat: { id: 555000111 }, new_chat_member: {} } }]),
      );
    // Only matches if the next call acknowledges update_id 5 by requesting
    // offset=6 — proving it was counted even though it never reached onCommand.
    const scope2 = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query({ offset: "6", timeout: "30" })
      .reply(200, updatesReply([]));
    mockQuietTail();

    const onCommand = vi.fn();
    const handle = startCommandPolling(config, isAuthorizedChat, onCommand);

    await vi.waitFor(() => {
      expect(scope2.isDone()).toBe(true);
    });

    expect(scope1.isDone()).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();

    void handle.stop();
  });

  it("uses offset = (max update_id seen) + 1 on the next getUpdates call", async () => {
    const scope1 = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query({ timeout: "30" }) // first request: no offset at all
      .reply(
        200,
        updatesReply([
          { update_id: 10, message: { chat: { id: 555000111 }, text: "/a" } },
          { update_id: 11, message: { chat: { id: 555000111 }, text: "/b" } },
        ]),
      );
    const scope2 = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query({ offset: "12", timeout: "30" })
      .reply(200, updatesReply([]));
    mockQuietTail();

    const handle = startCommandPolling(config, isAuthorizedChat, vi.fn());

    await vi.waitFor(() => {
      expect(scope2.isDone()).toBe(true); // proves the second call queried offset=12 exactly
    });

    expect(scope1.isDone()).toBe(true);

    void handle.stop();
  });

  it("does not stop the loop on a network error, retries only after errorBackoffMs, and never leaks the bot token to console.error", async () => {
    const scope1 = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query(true)
      .replyWithError(new Error("connection reset"));
    const scope2 = nock(TELEGRAM_BASE).get(GET_UPDATES_PATH).query(true).reply(200, updatesReply([]));
    mockQuietTail();

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startCommandPolling(config, isAuthorizedChat, vi.fn(), { errorBackoffMs: 150 });

    await vi.waitFor(() => {
      expect(scope1.isDone()).toBe(true);
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(scope2.isDone()).toBe(false); // must not have retried yet

    // Real, short wait well under errorBackoffMs: proves it doesn't retry early.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scope2.isDone()).toBe(false);

    // Generous real wait past errorBackoffMs: proves it does eventually retry.
    await vi.waitFor(
      () => {
        expect(scope2.isDone()).toBe(true);
      },
      { timeout: 2000 },
    );

    void handle.stop();

    // RR-33-adjacent discipline (see telegramPolling.ts's pollOnce catch
    // block): never let the token-bearing getUpdates URL reach a logger.
    // Check every arg of every console.error call, not just the first, so a
    // leak via a second/incidental call can't hide.
    for (const call of consoleErrorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(FAKE_TOKEN);
      }
    }

    consoleErrorSpy.mockRestore();
  });

  it("stop() prevents the next getUpdates call from starting, even when called while the first request is still in flight", async () => {
    // A mutable container, not a rebound `let`: the reply callback below is
    // registered (and needs to close over the eventual handle) before
    // startCommandPolling has run and produced one.
    const handleRef: { current?: TelegramPollingHandle } = {};

    // stop() is invoked from inside nock's own reply callback, i.e. exactly
    // while the first getUpdates request is being handled — the scenario the
    // spec calls out explicitly: that in-flight request is still allowed to
    // finish, but nothing after it may start.
    const scope1 = nock(TELEGRAM_BASE)
      .get(GET_UPDATES_PATH)
      .query(true)
      .reply(function replyAndStop() {
        void handleRef.current?.stop();
        return [200, updatesReply([])];
      });

    handleRef.current = startCommandPolling(config, isAuthorizedChat, vi.fn());

    await vi.waitFor(() => {
      expect(scope1.isDone()).toBe(true);
    });

    // Registered only now, so it could only ever be consumed by a call that
    // happens after stop() already fired — which must never come.
    const scope2 = nock(TELEGRAM_BASE).get(GET_UPDATES_PATH).query(true).reply(200, updatesReply([]));

    // Generous real wait: proves no second call ever comes, not just that it
    // hasn't come yet.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(scope2.isDone()).toBe(false);
  });

  it("aborts a getUpdates call that hangs past fetchTimeoutMs (black-holed connection), treats it as a failed attempt, and retries", async () => {
    // Simulates a client-side-dead connection: nock never actually answers
    // within this test's lifetime, standing in for a black-holed TCP
    // connection with no RST. A real one would hang indefinitely; this one
    // just has to outlast the short fetchTimeoutMs below.
    const hungScope = nock(TELEGRAM_BASE).get(GET_UPDATES_PATH).query(true).delay(60_000).reply(200, updatesReply([]));
    const recoveryScope = nock(TELEGRAM_BASE).get(GET_UPDATES_PATH).query(true).reply(200, updatesReply([]));
    mockQuietTail();

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startCommandPolling(config, isAuthorizedChat, vi.fn(), {
      fetchTimeoutMs: 100,
      errorBackoffMs: 50,
    });

    await vi.waitFor(
      () => {
        expect(recoveryScope.isDone()).toBe(true);
      },
      { timeout: 2000 },
    );

    expect(hungScope.isDone()).toBe(true); // the hung request was actually sent, just never answered in time
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("timed out after 100ms"));

    // Same RR-33-adjacent token-leak discipline as the network-error test above.
    for (const call of consoleErrorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(FAKE_TOKEN);
      }
    }

    void handle.stop();
    consoleErrorSpy.mockRestore();
  });
});
