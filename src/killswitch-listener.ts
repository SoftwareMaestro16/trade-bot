import path from "node:path";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { loadEnv } from "./config/env.js";
import { applyFlattenAll, applyHaltNew, clearHalt } from "./killswitch/haltState.js";
import type { HaltState } from "./killswitch/haltState.js";
import { selfTestFileFlag, startFileFlagWatcher } from "./killswitch/fileFlag.js";
import { loadHaltState, saveHaltState } from "./killswitch/haltStatePersistence.js";
import { createPersistQueue } from "./killswitch/persistQueue.js";
import type { HaltStateDatabase } from "./killswitch/haltStatePersistence.js";
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
   * NEVER throws/rejects — every call site below is a bare `void
   * applyAndPersist(...)` with nothing to attach a `.catch()` to. Before this
   * was fixed, a transient `saveHaltState` failure (a DB connection reset,
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
    void applyAndPersist(
      applyHaltNew(state, "file flag detected", "file-flag", Date.now()),
      `🛑 <b>HALT_NEW</b> triggered via file flag (${flagPath})`,
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

  // RR-33: only a chat_id already in the whitelist ever reaches this
  // function at all — authorizeCommand() has already filtered by the time
  // startCommandPolling calls onCommand.
  function handleAuthorizedCommand(command: string, args: string[]): void {
    switch (command) {
      case "stop":
        void applyAndPersist(
          applyHaltNew(state, "manual /stop", "telegram", Date.now()),
          "🛑 <b>HALT_NEW</b> — new entries blocked via /stop",
        );
        break;

      case "flatten":
        void applyAndPersist(
          applyFlattenAll(state, "manual /flatten", "telegram", Date.now()),
          "🛑 <b>FLATTEN_ALL</b> — new entries blocked, closing everything, via /flatten " +
            "(no execution/ order placement exists yet — this raises the flag for when it does)",
        );
        break;

      case "resume": {
        const confirmedBy = `telegram:${args.join(" ") || "operator"}`;
        try {
          const cleared = clearHalt(state, confirmedBy, Date.now());
          void applyAndPersist(cleared, `✅ Halt cleared via /resume (confirmed by ${confirmedBy})`);
        } catch (e) {
          logger.error({ err: e }, "/resume rejected");
        }
        break;
      }

      case "status":
        void sendStatusReport();
        break;

      default:
        logger.info({ command }, "unrecognized command");
    }
  }

  let telegramPolling: TelegramPollingHandle | null = null;
  if (telegramConfig) {
    telegramPolling = startCommandPolling(telegramConfig, (result) => {
      if (!result.authorized) {
        // RR-33: every rejection is logged, no exceptions — this IS that logging.
        logger.error({ rejectedChatId: result.rejectedChatId }, "REJECTED command from unauthorized chat_id");
        return;
      }
      handleAuthorizedCommand(result.command, result.args);
    });
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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "received, shutting down...");
    fileFlagWatcher.stop();
    // Awaited, not fire-and-forget: telegramPolling.stop() only resolves once
    // any in-flight getUpdates round-trip (and whatever command dispatch it
    // triggers) has actually finished. db.destroy() below must never run
    // while a /stop or /flatten that arrived right at shutdown is still being
    // persisted — otherwise that write can be aborted mid-flight by the
    // closing pool and silently lost.
    await telegramPolling?.stop();
    await db.destroy();
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info("ready");
}

main().catch((e: unknown) => {
  logger.error({ err: e }, "fatal error during startup");
  process.exit(1);
});
