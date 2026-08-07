import { authorizeCommand } from "../telegram.js";
import type { AuthorizedCommand, ChatAuthorizer, TelegramConfig } from "../telegram.js";
import { asRecord, safeJsonParse, parseUpdate } from "./updateParsing.js";

/**
 * Split out of telegramPolling.ts (now this folder's barrel) — the raw
 * long-poll HTTP/getUpdates mechanics and the loop itself, including
 * chat-authorization dispatch via `authorizeCommand`. Update parsing lives
 * separately in ./updateParsing.ts; the public option/handle shapes live in
 * ./types.ts.
 */

export interface TelegramPollingOptions {
  /** Telegram's own long-poll `timeout` query parameter, in seconds. Default 30. */
  timeoutSeconds?: number;
  /** Delay before retrying after a failed getUpdates attempt. Default 5000. */
  errorBackoffMs?: number;
  /**
   * Hard client-side deadline (via AbortController) on a single getUpdates
   * round-trip. Defaults to `timeoutSeconds*1000 + FETCH_TIMEOUT_MARGIN_MS` —
   * see pollOnce's own comment for why this exists at all. Overridable here
   * only so tests don't have to wait out the real default.
   */
  fetchTimeoutMs?: number;
}

/**
 * A tapped inline-keyboard button, after the SAME authorizeCommand gate
 * every typed command goes through — see updateParsing.ts's ParsedCallbackQuery
 * and killswitch/buttonRouter.ts. `auth` reuses AuthorizedCommand's exact
 * shape (callback_data is treated as a bare, slash-free "text" — authorizeCommand
 * parses "stop" into `{command:"stop", args:[]}` the same way it would parse
 * a typed "/stop"), so callers never need a second authorization code path.
 * `callbackQueryId`/`messageId` are needed only for answerCallbackQuery/
 * editMessageText, not for the authorization decision itself.
 */
export interface CallbackQueryDispatch {
  auth: AuthorizedCommand;
  callbackQueryId: string;
  messageId: number;
}

export interface TelegramPollingHandle {
  /**
   * Resolves once the loop has actually exited — not merely once no further
   * iteration will start. Without this, a caller tearing down a resource
   * `onCommand` depends on (e.g. a DB pool) right after calling `stop()` can
   * race an in-flight `pollOnce()`/`onCommand` dispatch that was already
   * running when `stop()` was called: `stopped=true` only prevents the NEXT
   * iteration, it doesn't retroactively cancel the current one.
   */
  stop: () => Promise<void>;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_ERROR_BACKOFF_MS = 5000;
// Margin added on top of the `timeout` query param to get the client-side
// fetch deadline: generous enough that it should never fire on a legitimate
// long-poll response (Telegram already holds the connection open up to
// ~timeoutSeconds before answering; this is headroom for connect time + the
// actual body of a real reply on top of that), while still being a real,
// finite bound instead of none at all.
const FETCH_TIMEOUT_MARGIN_MS = 15_000;

/**
 * Starts an indefinite getUpdates long-poll loop. Every update that carries
 * `message.text` is run through `authorizeCommand` (awaited — `isAuthorizedChat`
 * may hit the DB, see killswitch-listener.ts's own `isAuthorizedChat`) and
 * handed to `onCommand` — both `authorized:true` and `authorized:false`
 * results, always. Per authorizeCommand's own JSDoc (RR-33, SRS.md), logging
 * a rejection is the caller's responsibility, not authorizeCommand's and not
 * this function's: `onCommand` is where that has to happen. `onCommand`
 * itself stays a synchronous callback — all the async work happens inside
 * `pollOnce` before `onCommand` is ever invoked.
 *
 * Loop shape mirrors collector.ts's scheduleRepeating: a `stopped` flag that
 * gates every scheduled continuation, plus a timer handle stop() clears —
 * so stop() can only ever let an already-in-flight getUpdates request finish;
 * it always prevents the next one. Unlike scheduleRepeating there's no fixed
 * spacing on the happy path: re-polling immediately after a successful
 * response is correct, not a busy-loop, because `timeout=<timeoutSeconds>` in
 * the query already makes Telegram hold the connection open (up to ~30s+) until
 * an update arrives or the long-poll itself times out. errorBackoffMs only
 * applies after a failed attempt, so a downed network path or a Telegram outage
 * doesn't turn into a tight retry loop.
 */
export function startCommandPolling(
  config: TelegramConfig,
  isAuthorizedChat: ChatAuthorizer,
  onCommand: (result: AuthorizedCommand) => void,
  options?: TelegramPollingOptions,
  onCallbackQuery?: (result: CallbackQueryDispatch) => void,
): TelegramPollingHandle {
  const timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const errorBackoffMs = options?.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS;
  const fetchTimeoutMs = options?.fetchTimeoutMs ?? timeoutSeconds * 1000 + FETCH_TIMEOUT_MARGIN_MS;

  let stopped = false;
  // Telegram's own protocol: omit `offset` (or send 0) on the very first
  // request; from then on it's (highest update_id seen so far) + 1, which is
  // how a long-poll client acknowledges receipt so those updates aren't
  // redelivered.
  let offset: number | undefined;
  // Set only while loop() is inside sleep()'s wait, so stop() can cut that
  // wait short instead of leaving the loop parked for up to errorBackoffMs
  // after being asked to stop. Cleared while a getUpdates call is actually
  // in flight, so a stale reference from a previous wait can never fire.
  let wakeNow: (() => void) | undefined;

  const buildUrl = (): string => {
    const params = new URLSearchParams();
    if (offset !== undefined) {
      params.set("offset", String(offset));
    }
    params.set("timeout", String(timeoutSeconds));
    // config.botToken is embedded in this URL. Never pass this url (or this
    // function's result) to console.error/console.log — see the catch block
    // and both failure branches in tick() below, none of which do.
    return `https://api.telegram.org/bot${config.botToken}/getUpdates?${params.toString()}`;
  };

  /** One getUpdates round-trip. Returns true on success, false on any failure. */
  const pollOnce = async (): Promise<boolean> => {
    // Node's global `fetch` has no default timeout, and the `timeout` query
    // param in buildUrl() only bounds TELEGRAM's own server-side wait — never
    // a client-side TCP connection that's gone dead with no RST. Without
    // this, a black-holed connection at exactly the wrong moment can wedge
    // this call (and therefore the awaited loopPromise behind
    // TelegramPollingHandle.stop()) indefinitely, which in turn can stall
    // killswitch-listener.ts's shutdown() well past what an operator expects.
    // Covers both the fetch() call and the response.text() read below via the
    // same signal — aborting mid-body-read rejects that too, not just a
    // not-yet-started request.
    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => abortController.abort(), fetchTimeoutMs);

    let response: Response;
    try {
      response = await fetch(buildUrl(), { signal: abortController.signal });
    } catch (e) {
      clearTimeout(timeoutTimer);
      // Same discipline as telegram.ts's sendAlert: pull only `.message` out
      // of the caught value, never log `e` itself and never log the request
      // url — some fetch/undici failure shapes keep a reference back to the
      // request (and therefore to the token-bearing url) that an upstream
      // `console.error(error)` could otherwise echo straight into the log.
      const message = typeof e === "string" ? e : e instanceof Error ? e.message : "unrecognized error shape";
      console.error(
        abortController.signal.aborted
          ? `[telegram-polling] getUpdates timed out after ${fetchTimeoutMs}ms (client-side deadline, not Telegram's own \`timeout\` param) — likely a dead/black-holed connection`
          : `[telegram-polling] getUpdates network error: ${message}`,
      );
      return false;
    }

    let rawBody: string;
    try {
      // Reading the body is a separate failure point from the fetch() call
      // above — a long-poll connection Telegram holds open ~30s can still drop
      // mid-body-read. Unguarded, that rejection propagated out of pollOnce()
      // uncaught (loop() awaits pollOnce() with no try/catch, started via bare
      // `void loop()`), which is an unhandled promise rejection — an uncaught
      // exception in Node by default, crashing the whole process this
      // function runs in (killswitch-listener.ts, both Level-1 paths at once).
      rawBody = await response.text();
    } catch (e) {
      clearTimeout(timeoutTimer);
      const message = typeof e === "string" ? e : e instanceof Error ? e.message : "unrecognized error shape";
      console.error(
        abortController.signal.aborted
          ? `[telegram-polling] getUpdates timed out after ${fetchTimeoutMs}ms (client-side deadline, not Telegram's own \`timeout\` param) — likely a dead/black-holed connection mid-body-read`
          : `[telegram-polling] getUpdates response body read failed: ${message}`,
      );
      return false;
    }
    clearTimeout(timeoutTimer);
    const body = asRecord(safeJsonParse(rawBody));
    const description = body && typeof body.description === "string" ? body.description : undefined;

    if (!response.ok) {
      console.error(
        `[telegram-polling] getUpdates failed: HTTP ${response.status}${description ? `: ${description}` : ""}`,
      );
      return false;
    }
    // Telegram sometimes answers HTTP 200 with ok:false in the JSON body (same
    // gotcha telegram.ts's sendAlert guards against) — an HTTP-status-only
    // check would silently swallow that failure instead of backing off.
    if (body === undefined || body.ok !== true) {
      console.error(`[telegram-polling] getUpdates rejected: ${description ?? "unknown error"}`);
      return false;
    }

    const rawUpdates = Array.isArray(body.result) ? body.result : [];
    let maxUpdateId: number | undefined;

    for (const rawUpdate of rawUpdates) {
      const { updateId, command, callbackQuery } = parseUpdate(rawUpdate);
      if (updateId !== undefined && (maxUpdateId === undefined || updateId > maxUpdateId)) {
        maxUpdateId = updateId;
      }
      if (command !== undefined) {
        // Guarded for the same reason as the response.text() fix above: a
        // caller bug in onCommand (or in isAuthorizedChat, awaited inside
        // authorizeCommand) must not be able to kill this loop (and the whole
        // process it runs in) over a single bad command.
        try {
          onCommand(await authorizeCommand(isAuthorizedChat, command));
        } catch (e) {
          console.error("[telegram-polling] onCommand handler threw:", e instanceof Error ? e.message : e);
        }
      }
      if (callbackQuery !== undefined && onCallbackQuery) {
        // Same authorizeCommand gate as a typed command — callback_data is
        // just "text" with no leading slash, which authorizeCommand parses
        // into the identical {command, args} shape. Same try/catch guard as
        // the onCommand branch above, for the same reason.
        try {
          const auth = await authorizeCommand(isAuthorizedChat, { chatId: callbackQuery.chatId, text: callbackQuery.data });
          onCallbackQuery({ auth, callbackQueryId: callbackQuery.id, messageId: callbackQuery.messageId });
        } catch (e) {
          console.error("[telegram-polling] onCallbackQuery handler threw:", e instanceof Error ? e.message : e);
        }
      }
    }

    if (maxUpdateId !== undefined) {
      offset = maxUpdateId + 1;
    }
    return true;
  };

  /**
   * Resolves after `ms` (or immediately if stop() calls the stashed
   * `wakeNow` first). Deliberately a bare `setTimeout(resolve, ms)` — the
   * callback IS the promise executor's own resolve function, not a wrapper
   * that fires-and-forgets an inner async call the way collector.ts's
   * scheduleRepeating does (`setTimeout(() => void tick(), ms)`). That
   * distinction is what makes loop() below a genuine `async` function that
   * `await`s its way through every iteration, rather than a chain of
   * detached, un-awaitable callbacks: the whole loop is one real promise
   * chain from `void loop()` onward, which is what lets stop() reason
   * precisely about "in flight" vs "not yet started" (see loop()'s doc
   * comment) instead of just hoping a `stopped` flag gets checked in time.
   */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeNow = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /**
   * Runs until stop(). No fixed spacing on the happy path — see this
   * function's outer JSDoc for why re-polling immediately after success is
   * correct — so `sleep(0)` there is purely a yield point, not a delay;
   * `sleep(errorBackoffMs)` after a failure is the real one. `stopped` is
   * checked both right after pollOnce() resolves (so a stop() that arrived
   * while a request was in flight is honored the instant it returns, without
   * waiting out a sleep first) and at the top of the loop (so a stop() that
   * arrived during sleep() — woken early via `wakeNow` — exits right away
   * too).
   */
  const loop = async (): Promise<void> => {
    while (!stopped) {
      wakeNow = undefined;
      const succeeded = await pollOnce();
      if (stopped) break;
      await sleep(succeeded ? 0 : errorBackoffMs);
    }
  };

  // Captured (not fire-and-forget from stop()'s perspective) so stop() can
  // hand callers something to await. loop() itself can't throw — pollOnce()
  // catches every failure internally and sleep() is a bare timer promise —
  // so this never rejects.
  const loopPromise = loop();

  return {
    stop: () => {
      stopped = true;
      wakeNow?.();
      return loopPromise;
    },
  };
}
