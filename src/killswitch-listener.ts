import path from "node:path";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { loadEnv } from "./config/env.js";
import { applyFlattenAll, applyHaltNew, clearHalt } from "./killswitch/haltState.js";
import type { HaltState } from "./killswitch/haltState.js";
import { selfTestFileFlag, startFileFlagWatcher } from "./killswitch/fileFlag.js";
import { loadHaltState, saveHaltState } from "./killswitch/haltStatePersistence.js";
import { createPersistQueue } from "./killswitch/persistQueue.js";
import { createInFlightTracker } from "./killswitch/inFlightPersists.js";
import type { HaltStateDatabase } from "./killswitch/haltStatePersistence.js";
import { isAuthorizedChat, manageAuthorizedUserCommand } from "./killswitch/authorizedUsers.js";
import { logger as rootLogger } from "./logger.js";
import { sendAlert, sendRichMessage } from "./notify/telegram.js";
import type { TelegramConfig } from "./notify/telegram.js";
import { startCommandPolling } from "./notify/telegramPolling.js";
import type { TelegramPollingHandle } from "./notify/telegramPolling.js";
import { computeStatusReport, formatStatusReportTable } from "./notify/statusReport.js";
import type { Database } from "./storage/schema.js";

const logger = rootLogger.child({ module: "killswitch-listener" });

/**
 * RR-31 (SRS.md): kill switch level 1 lives in a SEPARATE OS process from
 * collector.ts — a wedged main loop cannot poll Telegram or notice a file
 * appear, so a stop mechanism living inside that same loop is not a kill
 * switch by definition. This process shares nothing with collector.ts at
 * runtime except the `halt_state` DB row and the file-flag path; it does not
 * import collector.ts and collector.ts does not import this file.
 *
 * Scope today: this process can raise/clear HALT_NEW and FLATTEN_ALL and
 * make that durable and observable (DB + file + Telegram). It cannot yet
 * actually flatten anything on the exchange — there is no execution/ order
 * placement wired up, no Trade-permission key, and nothing this project has
 * ever opened a position for. Building the STATE half now, ahead of the I/O
 * that will act on it, mirrors execution/'s own pairIntentState.ts: get the
 * contract right before there is anything live to break.
 */

const DEFAULT_FLAG_FILENAME = "KILLSWITCH_STOP";

async function main(): Promise<void> {
  const env = loadEnv();

  const flagPath = path.resolve(env.KILLSWITCH_FLAG_PATH ?? path.join(process.cwd(), DEFAULT_FLAG_FILENAME));
  logger.info({ flagPath }, "file flag path");

  // RISK-REGISTER.md FM-34: refuse to start trading-adjacent infrastructure
  // if the one mechanism meant to stop it can't prove it works on this host.
  const selfTestOk = await selfTestFileFlag(flagPath);
  if (!selfTestOk) {
    logger.error("FATAL: file-flag self-test failed — refusing to start. See preceding log lines for which step failed.");
    process.exit(1);
  }
  logger.info("file-flag self-test passed");

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  // See storage/db.ts's identical handler for why this is required, not optional:
  // an idle-connection background error with zero 'error' listeners is an uncaught
  // exception in Node — it would kill this process (both kill switch paths at once)
  // over a DB hiccup that has nothing to do with any in-flight command.
  pool.on("error", (err) => {
    logger.error({ err }, "background pool error on an idle connection");
  });
  const db = new Kysely<HaltStateDatabase>({ dialect: new PostgresDialect({ pool }) });
  // Same pool, second narrowly-typed Kysely wrapper — Kysely instances are
  // thin query-building layers over a shared driver, not a resource of their
  // own, so a second one costs nothing beyond object allocation. Kept
  // separate from `db` above rather than merging their table types into one
  // union: Kysely's own `transaction()` typing makes `Kysely<A & B>` NOT
  // structurally assignable to `Kysely<A>`/`Kysely<B>` individually (tried,
  // confirmed via tsc), so a merged type would need casts at every call site
  // instead of none.
  const statusDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  let state = await loadHaltState(db);
  logger.info(
    { haltNew: state.haltNew, flattenAll: state.flattenAll, reason: state.reason, setBy: state.setBy },
    "loaded halt state",
  );

  const telegramConfig: TelegramConfig | null =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? { botToken: env.TELEGRAM_BOT_TOKEN, allowedChatId: env.TELEGRAM_CHAT_ID }
      : null;

  /**
   * Persists first, alerts second, and a failed alert never rolls back or
   * hides the persisted change — the halt is real the moment it's written to
   * `halt_state`; Telegram is a notification about a fact, not part of
   * deciding the fact. Logged either way, so `journalctl` alone is always a
   * complete record even with Telegram fully down (RUNBOOK.md §4 fallback).
   *
   * NEVER throws/rejects — every call site below is fire-and-forget
   * (`inFlightPersists.track(applyAndPersist(...))`, see inFlightPersists.ts)
   * with nothing that attaches a `.catch()` of its own. Before this was fixed,
   * a transient `saveHaltState` failure (a DB connection reset,
   * say) was an unhandled promise rejection there — an uncaught exception in
   * Node by default, which killed this entire process, taking down BOTH
   * Level-1 paths (file-flag AND Telegram) over exactly the kind of hiccup an
   * operator issuing /stop or /flatten mid-incident can least afford. The
   * in-memory `state` assignment above is deliberately NOT rolled back on a
   * persist failure: a real command was issued, and this process should keep
   * behaving as halted for as long as it's alive even if the DB write
   * failed — reverting to "not halted" here would be strictly more dangerous
   * than staying halted-but-not-yet-durable.
   */
  // See persistQueue.ts's own doc comment for why this exists: saveHaltState
  // calls must commit in the order applyAndPersist was CALLED, not the order
  // their independent network round-trips happen to complete.
  const enqueuePersist = createPersistQueue();

  // See inFlightPersists.ts's own doc comment: every call site below invokes
  // applyAndPersist as `void applyAndPersist(...)` (deliberately — a slow
  // persist must never block command handling), which otherwise leaves
  // nothing for shutdown() to await before db.destroy() runs.
  // inFlightPersists.track() is that missing handle; shutdown() drains it below.
  const inFlightPersists = createInFlightTracker();

  async function applyAndPersist(next: HaltState, logLine: string): Promise<void> {
    state = next;
    try {
      await enqueuePersist(() => saveHaltState(db, next));
    } catch (e) {
      logger.error({ err: e, logLine }, "FAILED TO PERSIST (state is still applied in-memory)");
      if (telegramConfig) {
        try {
          await sendAlert(
            telegramConfig,
            `⚠️ <b>PERSIST FAILED</b> — ${logLine}\nThis process still behaves accordingly, but the DB write failed — a restart before this is fixed will lose it. Investigate the database.`,
            { parseMode: "HTML" },
          );
        } catch (alertError) {
          logger.error({ err: alertError }, "...and the failure alert itself also failed to send");
        }
      }
      return;
    }
    logger.info(logLine);
    if (telegramConfig) {
      try {
        await sendAlert(telegramConfig, logLine, { parseMode: "HTML" });
      } catch (e) {
        logger.error({ err: e }, "state change persisted, but the Telegram alert failed to send");
      }
    }
  }

  // FM-34 / fileFlag.ts's own documented boundary: a flag already present at
  // startup (e.g. this process restarted while Level 1 was active) is not a
  // transition the watcher's OWN polling will ever see as a transition — it
  // must be caught from the SAME read that seeds the watcher's baseline, not
  // a separate isFlagPresent() call before starting it. Two separate reads
  // would leave a real TOCTOU gap (see fileFlag.ts's own doc comment on
  // startFileFlagWatcher): a flag created in the instant between them would
  // be caught by neither this check (already read false) nor the watcher
  // (whose baseline would already read true, so it'd never see a transition
  // either) — silently unnoticed for as long as the file sits there.
  const fileFlagWatcher = startFileFlagWatcher({ flagFilePath: flagPath }, () => {
    inFlightPersists.track(
      applyAndPersist(
        applyHaltNew(state, "file flag detected", "file-flag", Date.now()),
        `🛑 <b>HALT_NEW</b> triggered via file flag (${flagPath})`,
      ),
    );
  });

  if (fileFlagWatcher.wasPresentAtStart) {
    await applyAndPersist(
      applyHaltNew(state, "file flag already present at startup", "file-flag", Date.now()),
      `🛑 <b>HALT_NEW</b> — file flag was already present at startup (${flagPath})`,
    );
  }

  /**
   * Owner's own request: "/status одним сообщением — что работает, что нет,
   * прибавлялись ли данные" — supersedes the old kill-switch-only status text
   * (kill switch state is now just the first section of the same report).
   * Queries the DB fresh on every call rather than reusing any in-memory
   * state from collector.ts (there is none to reuse — separate process,
   * RR-31) — that live DB read IS the point: this has to keep working, and
   * keep meaning something, even if collector.ts itself is wedged or dead.
   */
  async function sendStatusReport(): Promise<void> {
    if (!telegramConfig) return;
    try {
      const report = await computeStatusReport(statusDb, state);
      await sendRichMessage(telegramConfig, formatStatusReportTable(report));
    } catch (e) {
      logger.error({ err: e }, "failed to build/send /status reply");
    }
  }

  /**
   * Thin logging wrapper around killswitch/authorizedUsers.ts's
   * manageAuthorizedUserCommand, which owns the actual root-admin gate +
   * candidate validation + DB mutation (and is unit-tested directly there,
   * against a real Postgres, independent of this whole process). This
   * function's only job is turning that function's outcome into a log line —
   * same division of labor as applyAndPersist (state transition happens in
   * haltState.ts, this file only persists + logs + alerts).
   */
  async function manageAuthorizedUser(
    command: "add" | "delete",
    candidate: string | undefined,
    senderChatId: string,
    rootAdminChatId: string,
  ): Promise<void> {
    const result = await manageAuthorizedUserCommand(statusDb, { command, senderChatId, rootAdminChatId, candidate });
    switch (result.outcome) {
      case "rejected_not_root_admin":
        // Should be unreachable in practice — handleAuthorizedCommand's own
        // "add"/"delete" case already checked this before calling here — but
        // logged loudly (not silently ignored) in case that invariant is
        // ever broken by a future edit to this file.
        logger.error({ command, senderChatId }, `/${command}: REJECTED — sender is not the root admin`);
        break;
      case "rejected_invalid_candidate":
        logger.error(
          { command, candidate: result.candidate },
          `/${command}: invalid/suspicious chat_id argument — not ${command === "add" ? "added" : "deleted"}`,
        );
        break;
      case "added":
        logger.info({ chatId: result.chatId, addedBy: rootAdminChatId }, "/add: chat_id authorized (idempotent)");
        break;
      case "removed":
        logger.info(
          { chatId: result.chatId, wasPresent: result.wasPresent },
          "/delete: chat_id removed (idempotent — wasPresent:false means it wasn't there)",
        );
        break;
      case "db_error":
        logger.error({ err: result.error, command, candidate }, `/${command} failed against authorized_users`);
        break;
    }
  }

  // RR-33 (extended): only a chat_id that's either the root admin or already
  // in the authorized_users table ever reaches this function at all —
  // isAuthorizedChat/authorizeCommand have already filtered by the time
  // startCommandPolling calls onCommand. `chatId` is that already-authorized
  // sender, needed here specifically for /add and /delete: those two
  // commands are further restricted to ONLY the root admin, not every
  // authorized chat_id — see the "add"/"delete" case below.
  function handleAuthorizedCommand(command: string, args: string[], chatId: string): void {
    switch (command) {
      case "stop":
        inFlightPersists.track(
          applyAndPersist(
            applyHaltNew(state, "manual /stop", "telegram", Date.now()),
            "🛑 <b>HALT_NEW</b> — new entries blocked via /stop",
          ),
        );
        break;

      case "flatten":
        inFlightPersists.track(
          applyAndPersist(
            applyFlattenAll(state, "manual /flatten", "telegram", Date.now()),
            "🛑 <b>FLATTEN_ALL</b> — new entries blocked, closing everything, via /flatten " +
              "(no execution/ order placement exists yet — this raises the flag for when it does)",
          ),
        );
        break;

      case "resume": {
        const confirmedBy = `telegram:${args.join(" ") || "operator"}`;
        try {
          const cleared = clearHalt(state, confirmedBy, Date.now());
          inFlightPersists.track(
            applyAndPersist(cleared, `✅ Halt cleared via /resume (confirmed by ${confirmedBy})`),
          );
        } catch (e) {
          logger.error({ err: e }, "/resume rejected");
        }
        break;
      }

      case "status":
        void sendStatusReport();
        break;

      // Owner's own requirement: /add and /delete manage WHO can issue any
      // of the commands above, so they must be restricted to the root admin
      // ONLY — a chat_id merely present in authorized_users (and therefore
      // already able to reach this function per the comment above) must NOT
      // be able to authorize further chat_ids or de-authorize others. No
      // reply is sent to the rejecting chat_id: there is no general
      // "reply to an arbitrary chat_id" mechanism in this codebase (outbound
      // sendAlert/sendRichMessage/sendDocument all target config.allowedChatId
      // only, deliberately untouched by this change), so this is
      // logged-and-silently-dropped, same as an RR-33 rejection.
      case "add":
      case "delete":
        if (!telegramConfig) {
          logger.error({ chatId, command, args }, `REJECTED /${command} — Telegram is not configured`);
          break;
        }
        // The root-admin-only gate is also enforced inside
        // manageAuthorizedUserCommand itself (manageAuthorizedUser above logs
        // its "rejected_not_root_admin" outcome loudly if that ever
        // triggers) — checked here too so a non-root sender's attempt is
        // logged immediately, without an extra DB round trip.
        if (chatId !== telegramConfig.allowedChatId) {
          logger.error(
            { chatId, command, args },
            `REJECTED /${command} — only the root admin chat_id may manage authorized_users`,
          );
          break;
        }
        void manageAuthorizedUser(command, args[0], chatId, telegramConfig.allowedChatId);
        break;

      default:
        logger.info({ command }, "unrecognized command");
    }
  }

  let telegramPolling: TelegramPollingHandle | null = null;
  if (telegramConfig) {
    // Captured as its own const (rather than reading telegramConfig.allowedChatId
    // inside the arrow function below) purely so the ChatAuthorizer closure is
    // unambiguously a plain string, not TelegramConfig | null — telegramConfig
    // itself stays non-null for this whole `if` block, but this keeps the
    // isAuthorizedChat call site trivial to read either way.
    const rootAdminChatId = telegramConfig.allowedChatId;
    telegramPolling = startCommandPolling(
      telegramConfig,
      (chatId) => isAuthorizedChat(statusDb, rootAdminChatId, chatId),
      (result) => {
        if (!result.authorized) {
          // RR-33: every rejection is logged, no exceptions — this IS that logging.
          logger.error({ rejectedChatId: result.rejectedChatId }, "REJECTED command from unauthorized chat_id");
          return;
        }
        handleAuthorizedCommand(result.command, result.args, result.chatId);
      },
    );
    logger.info("Telegram command polling started");
  } else {
    // RR-32 requires two independent Level-1 paths; without Telegram
    // configured, only the file flag is live. This is a degraded mode the
    // owner has implicitly chosen by leaving TELEGRAM_* unset, not a crash —
    // but it must be loud, not silent.
    logger.warn(
      "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — running with ONLY the file-flag path. " +
        "RR-32 calls for two independent Level-1 paths; this is a degraded mode.",
    );
  }

  // Guards against a second SIGTERM/SIGINT (double Ctrl+C from an impatient
  // operator, a repeated `kill`, or SIGTERM+SIGINT arriving close together
  // during a VPS intervention) re-entering shutdown() while the first call is
  // still in flight — a second concurrent db.destroy() is not safe (pg-pool's
  // Pool.end() rejects if called again while the first call hasn't settled
  // yet), and it's exactly the same class of hazard collector.ts's own
  // shutdown() already guards against for the same reason — see that file's
  // shuttingDown comment.
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.info({ signal }, "shutdown already in progress, ignoring");
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "received, shutting down...");
    try {
      fileFlagWatcher.stop();
      // Awaited, not fire-and-forget: telegramPolling.stop() only resolves
      // once any in-flight getUpdates round-trip — and the synchronous
      // onCommand dispatch it triggers — has actually finished. That dispatch
      // only reaches as far as `inFlightPersists.track(applyAndPersist(...))`
      // though (see handleAuthorizedCommand's /stop, /flatten, /resume
      // cases): the persist itself is a separate promise pollOnce() never
      // awaits, so this alone does NOT guarantee a /stop or /flatten that
      // arrived right at shutdown has finished being persisted — see
      // inFlightPersists.drain() below, which is what actually closes that
      // gap. telegramPolling.ts's own getUpdates fetch has its own
      // AbortController timeout, so this can't hang forever on a black-holed
      // connection.
      await telegramPolling?.stop();
      // Drains every applyAndPersist call still in flight — fed by both the
      // file-flag path (whose watcher was already stopped above, so no new
      // one can start after this point) and the Telegram path (same, via
      // telegramPolling.stop() above). db.destroy() must never run while one
      // of these is still mid-write: without this, a /stop or /flatten
      // arriving right at shutdown could have its DB write silently aborted
      // by the closing pool — no error, no log line, no trace in journalctl.
      //
      // Deliberately no forced deadline on this wait (or on db.destroy()
      // below) — same reasoning collector.ts's own shutdown() already
      // documents for its own no-deadline choice: there is no deadline value
      // that's both short enough to reliably beat systemd's SIGKILL and long
      // enough to never cut off a genuinely in-flight (not stuck) persist —
      // forcing one here would trade today's "systemd SIGKILL after its own
      // TimeoutStopSec" failure mode for a self-inflicted one that abandons a
      // real halt/resume command's own write mid-flight on every restart that
      // happens to race a slow-but-healthy persist.
      await inFlightPersists.drain();
      await db.destroy();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (e) {
      // There is no process.on("unhandledRejection") anywhere in this
      // process, so letting any of the awaited steps above reject here would
      // be an unhandled rejection — the exact class of bug that could crash
      // this process (the kill switch itself) on exactly the kind of DB/
      // network hiccup an operator mid-incident can least afford. Logged and
      // exited non-zero instead: systemd sees a real failure, and whatever
      // DID complete above already ran.
      logger.error({ err: e, signal }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info("ready");
}

main().catch((e: unknown) => {
  logger.error({ err: e }, "fatal error during startup");
  process.exit(1);
});
