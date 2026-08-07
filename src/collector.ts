import { pathToFileURL } from "node:url";
import { loadEnv } from "./config/env.js";
import { PublicExchangeClient } from "./exchange/client.js";
import { RateLimiter } from "./exchange/rateLimiter.js";
import { logger as rootLogger } from "./logger.js";
import { LiquidationCollector } from "./market-data/collectLiquidations.js";
import { collectLongShortRatio } from "./market-data/collectLongShortRatio.js";
import { collectOrderbookSnapshots } from "./market-data/collectOrderbookSnapshots.js";
import { collectSettledFunding } from "./market-data/collectSettledFunding.js";
import { collectTickers } from "./market-data/collectTickers.js";
import { computeDigestStats } from "./market-data/collectionDigest.js";
import { runCollectionCycle } from "./market-data/collectionRun.js";
import { computeTradeableUniverse } from "./market-data/universe.js";
import type { UniverseSymbol } from "./market-data/universe.js";
import { scheduleDailyAt } from "./notify/dailySchedule.js";
import { formatDigestTable } from "./notify/formatDigest.js";
import { startHeartbeat } from "./notify/healthcheck.js";
import type { FreshnessCheck } from "./notify/healthcheck.js";
import { deliverPending, enqueueRichNotification } from "./notify/notificationQueue.js";
import { scheduleRepeating, type ScheduledTask } from "./scheduleRepeating.js";
import { createDb } from "./storage/db.js";

const logger = rootLogger.child({ module: "collector" });

/**
 * Phase 1 entrypoint (FR-100..FR-110): market-data collection only, no keys,
 * no positions, no execution/. This is NOT the eventual "trader" process from
 * ARCHITECTURE.md §1 — strategy/risk/execution get wired into a separate
 * entrypoint when those modules exist (SRS §10: "не пиши код на будущее").
 *
 * Cadences: only the orderbook interval is fixed by a decision (PARAMS-CONSERVATIVE.md
 * §1: top-50 once/minute). The rest are reasonable Phase 1 defaults, not SRS-mandated —
 * tunable once Phase 1's own data shows actual rate-limit headroom and how often
 * OI/long-short/settled-funding meaningfully change.
 */
const TICKER_INTERVAL_MS = 60_000;
const ORDERBOOK_INTERVAL_MS = 60_000;
const LONG_SHORT_INTERVAL_MS = 5 * 60_000;
const SETTLED_FUNDING_INTERVAL_MS = 5 * 60_000;
// RISK-REGISTER.md FM-04 requires `interval_minutes` to be a "live field with a
// one-cycle TTL, never a constant" — Bybit can flip a symbol's funding interval
// "typically within four minutes, without prior notice... exactly at extreme
// rates." Ticker/predicted-funding writes (funded from `universe`, see FR-101's
// per-symbol interval requirement) happen every TICKER_INTERVAL_MS; this used to
// be refreshed only once/hour, a 60x cadence gap that could leave a flipped
// interval silently wrong across ~60 written rows. 5 minutes matches this file's
// other per-symbol sweeps and keeps the worst-case staleness in the same order as
// FM-04's own "typically within four minutes" framing.
const UNIVERSE_REFRESH_INTERVAL_MS = 5 * 60_000;

// NFR-04 spacing between per-symbol calls. At ~293 mainnet symbols (FR-108),
// 80-150ms keeps a full sweep well under its own cadence (e.g. 293*150ms ≈ 44s
// inside a 5min window) and nowhere near Bybit's documented 600req/5s IP limit
// (RISK-REGISTER.md FM-19).
const ORDERBOOK_CALL_SPACING_MS = 80;
const LONG_SHORT_CALL_SPACING_MS = 150;
const SETTLED_FUNDING_CALL_SPACING_MS = 150;

// Telegram digest: owner asked for 12:00 and 20:00 Moscow time. Moscow has used
// a fixed UTC+3 offset with no DST since 2014, so this is a plain constant
// conversion (09:00/17:00 UTC), not a timezone-library concern — see
// notify/dailySchedule.ts's own doc comment for why that's safe here specifically.
const DIGEST_HOURS_UTC = [9, 17];
const DIGEST_MINUTE_UTC = 0;

// RUNBOOK.md §4: healthchecks.io's own guidance is to ping at roughly the
// check's expected interval. Since notify/healthcheck.ts's own staleness
// check (below) now gates the ping on a real DB write, this covers BOTH "is
// the OS process itself still alive" AND "is data actually landing in
// Postgres" — a stuck process that's still looping but whose writes are all
// silently failing (e.g. a dead DB connection) no longer looks healthy.
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

// How stale the newest `tickers`/`orderbook_levels` row is allowed to be
// before the heartbeat treats that stream as unhealthy and withholds its
// ping (letting healthchecks.io's own "ping didn't arrive" alert fire).
// Both run every 60s (TICKER_INTERVAL_MS/ORDERBOOK_INTERVAL_MS), so 10
// minutes tolerates ~10 consecutive missed cycles — generous enough that a
// single transient Bybit hiccup never false-alarms, tight enough that
// "running but writing nothing" is caught within one HEARTBEAT window
// either way.
const DB_STALE_AFTER_MS = 10 * 60_000;

// Same reasoning as DB_STALE_AFTER_MS, but for the two collectors that run
// every 5 minutes (LONG_SHORT_INTERVAL_MS/SETTLED_FUNDING_INTERVAL_MS) —
// 20 minutes tolerates ~4 consecutive missed cycles, keeping the same
// "generous but not blind" ratio (~10x the real interval) as the 60s streams
// above, rather than reusing DB_STALE_AFTER_MS unchanged and effectively
// tightening their tolerance to only ~2 missed cycles.
const SLOW_STREAM_STALE_AFTER_MS = 20 * 60_000;

// notificationQueue.ts's own retry cadence for anything still sitting
// undelivered (Telegram was down, network blip, etc.) — independent of the
// twice-daily digest schedule below, so a queued message doesn't wait up to
// 8 hours for its next retry attempt.
const NOTIFICATION_RETRY_INTERVAL_MS = 15 * 60_000;

// Purely diagnostic, not a forced cutoff (see shutdown()'s own doc comment for
// why a forced deadline isn't safe here): if shutdown() is still waiting on
// scheduled tasks this long after SIGTERM/SIGINT, log a warning so a hung REST
// call (bybit-api's axios client defaults to a 5min timeout, unoverridden —
// exchange/client.ts) leaves a trace in the journal before RUNBOOK.md's
// systemd unit's default 90s TimeoutStopSec can SIGKILL the process with no
// warning at all.
const SHUTDOWN_WARN_AFTER_MS = 60_000;

// ScheduledTask / scheduleRepeating moved to ./scheduleRepeating.ts (see its
// own doc comments for the no-overlap / error-swallowing / drain-on-stop
// guarantees) — extracted out of this file so it's independently testable
// the same way notify/dailySchedule.ts's scheduleDailyAt and
// notify/healthcheck.ts's startHeartbeat already are.

/**
 * Nothing downstream of computeTradeableUniverse ever checked
 * `universe.length > 0` before this existed: an empty result (e.g. an
 * upstream Bybit filter/schema change tripping FR-108's spot×perp
 * intersection to zero) would still wire up the WS liquidation subscription
 * and all 5 scheduleRepeating tasks below, and every cycle would run to
 * completion with symbolsCollected: 0 and collection_runs.status='completed'
 * — a fully silent total-collection failure, since runCollectionCycle has no
 * minimum-symbols check of its own and HEALTHCHECK_PING_URL (the only other
 * safety net) is optional and unset by default.
 *
 * Thrown, not just logged, at both call sites below: at startup this reaches
 * `main().catch` (fatal log + non-zero exit — a crash systemd/an operator can
 * actually see, instead of a healthy-looking process collecting nothing for
 * Phase 1's two-week window); inside the "universe-refresh" scheduleRepeating
 * task, scheduleRepeating's own try/catch (see its doc comment) turns this
 * into a logged "cycle failed" WITHOUT reassigning `universe` — so a single
 * bad refresh can never silently replace a good, previously-known-nonempty
 * universe with an empty one for the other 4 tasks' closures.
 */
export function assertUniverseNonEmpty(universe: UniverseSymbol[]): void {
  if (universe.length === 0) {
    throw new Error(
      "[collector] computeTradeableUniverse returned 0 tradeable symbols — refusing to run " +
        "collectors against an empty universe (FR-108 expects roughly 293 mainnet spot×perp symbols; " +
        "0 almost certainly means an upstream Bybit filter/schema change, not a real empty market)",
    );
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  // Deliberately NOT derived from env.APP_ENV. APP_ENV/RR-05 governs which KEY
  // PAIR an authenticated call may use (Phase 3+ concern) — it says nothing
  // about where Phase 1 should read PUBLIC market data from, and FR-100's own
  // header is explicit that Phase 1 needs no keys at all. Every FR-100..FR-108
  // number (754 perps, 408@4h/344@8h/2@1h funding intervals, 293-symbol
  // spot×perp intersection) was measured against real mainnet data (DECISIONS.md).
  // Testnet has thin/arbitrary liquidity — TEST-PLAN.md §"Три независимых контура"
  // is explicit that testnet answers "does the code work", never "is the
  // strategy profitable"; only mainnet public data feeds that question (Phase 2).
  // Collecting Phase 1's 2-week dataset from testnet would make it useless for
  // its actual purpose, so this client always points at mainnet regardless of
  // which trading environment the rest of the process is configured for.
  const client = new PublicExchangeClient({ testnet: false });

  let universe = await computeTradeableUniverse(client);
  assertUniverseNonEmpty(universe);
  logger.info({ appEnv: env.APP_ENV, universeSymbols: universe.length }, "startup");

  const liquidations = new LiquidationCollector(db, { testnet: false });
  liquidations.start(universe.map((u) => u.symbol));

  const orderbookLimiter = new RateLimiter(ORDERBOOK_CALL_SPACING_MS);
  const longShortLimiter = new RateLimiter(LONG_SHORT_CALL_SPACING_MS);
  const settledFundingLimiter = new RateLimiter(SETTLED_FUNDING_CALL_SPACING_MS);

  const tasks: ScheduledTask[] = [
    scheduleRepeating(
      "universe-refresh",
      async () => {
        const refreshed = await computeTradeableUniverse(client);
        assertUniverseNonEmpty(refreshed);
        universe = refreshed;
        logger.info({ task: "universe-refresh", universeSymbols: universe.length }, "universe refreshed");
        // Deliberately NOT re-subscribing the liquidation WS here: dynamic
        // resubscription for a universe that changes rarely (instrument listings)
        // is not worth the added complexity in Phase 1. A daily process restart
        // (RUNBOOK, not yet written) picks up universe changes for that stream.
      },
      UNIVERSE_REFRESH_INTERVAL_MS,
    ),

    scheduleRepeating(
      "tickers",
      async () => {
        await runCollectionCycle(db, universe.length, async () => {
          const r = await collectTickers(client, db, universe);
          return { symbolsCollected: r.symbolsCollected };
        });
      },
      TICKER_INTERVAL_MS,
    ),

    scheduleRepeating(
      "orderbook",
      async () => {
        await runCollectionCycle(db, universe.length, async () => {
          const r = await collectOrderbookSnapshots(client, db, universe, orderbookLimiter);
          if (r.failed.length > 0) logger.error({ task: "orderbook", failed: r.failed }, "symbols failed");
          return { symbolsCollected: r.symbolsCollected };
        });
      },
      ORDERBOOK_INTERVAL_MS,
    ),

    scheduleRepeating(
      "long-short-ratio",
      async () => {
        await runCollectionCycle(db, universe.length, async () => {
          const r = await collectLongShortRatio(client, db, universe, longShortLimiter);
          if (r.failed.length > 0) logger.error({ task: "long-short-ratio", failed: r.failed }, "symbols failed");
          // Unlike tickers/orderbook, this endpoint writes at most ONE row per
          // symbol (no linear/spot split), so `written` doesn't share those
          // collectors' row-vs-symbol miscount. It can UNDERcount by the rare
          // case of a symbol whose call succeeded but returned an empty list —
          // treated as "not collected" here, which is a defensible reading
          // (no data row exists for it this cycle either way), not the same
          // arithmetic bug class that was fixed elsewhere.
          return { symbolsCollected: r.written };
        });
      },
      LONG_SHORT_INTERVAL_MS,
    ),

    scheduleRepeating(
      "settled-funding",
      async () => {
        await runCollectionCycle(db, universe.length, async () => {
          const r = await collectSettledFunding(client, db, universe, settledFundingLimiter);
          if (r.failed.length > 0) logger.error({ task: "settled-funding", failed: r.failed }, "symbols failed");
          return { symbolsCollected: universe.length - r.failed.length };
        });
      },
      SETTLED_FUNDING_INTERVAL_MS,
    ),
  ];

  // Optional: only wired up if both Telegram variables are set (.env.example).
  // Absence is not an error — Phase 1 works fine without it, this is purely
  // "am I alive" reassurance, requested so the owner doesn't have to open a
  // terminal to check (RUNBOOK.md §4's systemctl/journalctl check remains the
  // fallback for when this message DOESN'T arrive, not the everyday path).
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const telegramConfig = { botToken: env.TELEGRAM_BOT_TOKEN, allowedChatId: env.TELEGRAM_CHAT_ID };
    let digestWindowStart = new Date();
    // Undefined until the first digest of this process lifetime has actually
    // been computed — formatDigestMessage treats "no previous" as "nothing to
    // diff against yet" rather than a fake ±0 baseline (notify/formatDigest.ts).
    let previousDigestStats: Awaited<ReturnType<typeof computeDigestStats>> | undefined;

    // Owner request: a failed send (Telegram down, network blip, whole
    // process down at send time) must not just vanish — it sits in
    // pending_telegram_messages (notify/notificationQueue.ts) until
    // delivered. Flush anything left over from a previous run FIRST, before
    // scheduling anything new, so a message that failed because the process
    // itself was down goes out immediately on the next start rather than
    // waiting for the next digest/retry tick.
    const startupQueueFlush = deliverPending(db, telegramConfig)
      .then((r) => {
        if (r.delivered > 0 || r.stillFailing > 0) {
          logger.info(
            { task: "startup", delivered: r.delivered, stillFailing: r.stillFailing },
            "flushed pending Telegram queue",
          );
        }
      })
      .catch((e: unknown) => logger.error({ err: e, task: "startup" }, "pending Telegram queue flush failed"));
    // Pushed into `tasks` (not just left as a dangling promise) so shutdown()'s
    // `Promise.all(tasks.map(t=>t.stop()))` waits for this flush's in-flight DB
    // write too, before `db.destroy()` runs — the same await-in-flight-before-
    // destroy protection ScheduledTask.stop gives every other collector (see its
    // own doc comment). Without this, a SIGTERM/SIGINT landing shortly after
    // startup could race the delivered_at UPDATE inside deliverPending against
    // pool teardown, which per notificationQueue.ts's own documented semantics
    // (see its "sent to Telegram but failed to record delivered_at" branch)
    // resends that message as a duplicate on the next start.
    tasks.push({ stop: () => startupQueueFlush });

    tasks.push(
      scheduleDailyAt(DIGEST_HOURS_UTC, DIGEST_MINUTE_UTC, async () => {
        const windowEnd = new Date();
        const stats = await computeDigestStats(db, digestWindowStart, windowEnd);
        await enqueueRichNotification(db, formatDigestTable(stats, previousDigestStats));
        await deliverPending(db, telegramConfig);
        digestWindowStart = windowEnd; // next digest reports only what's new since this one
        previousDigestStats = stats;
      }),
    );
    logger.info(
      { task: "startup", digestHoursUtc: DIGEST_HOURS_UTC },
      "Telegram digest enabled (12:00/20:00 MSK)",
    );

    // Independent of the digest's own schedule — a message stuck in the
    // queue (e.g. a killswitch alert sent while Telegram was unreachable)
    // gets retried on this cadence instead of waiting for the next digest.
    tasks.push(
      scheduleRepeating(
        "notification-queue-retry",
        async () => {
          const r = await deliverPending(db, telegramConfig);
          if (r.delivered > 0) {
            logger.info(
              { task: "notification-queue-retry", delivered: r.delivered, stillFailing: r.stillFailing },
              "delivered",
            );
          }
        },
        NOTIFICATION_RETRY_INTERVAL_MS,
      ),
    );
  } else {
    logger.info({ task: "startup" }, "Telegram digest disabled (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set)");
  }

  // Optional: only wired up if HEALTHCHECK_PING_URL is set (.env.example).
  // See notify/healthcheck.ts's own doc comment for why this is a genuinely
  // separate channel from the Telegram digest above, not a duplicate of it,
  // and for why these four checks (not six, not one) are exactly the
  // independently-scheduled write paths worth gating the ping on.
  if (env.HEALTHCHECK_PING_URL) {
    const freshnessChecks: FreshnessCheck[] = [
      {
        label: "tickers",
        staleAfterMs: DB_STALE_AFTER_MS,
        latestAt: async (checkDb) => {
          const row = await checkDb.selectFrom("tickers").select(({ fn }) => fn.max("fetched_at").as("latest")).executeTakeFirst();
          return row?.latest ?? null;
        },
      },
      {
        label: "orderbook_levels",
        staleAfterMs: DB_STALE_AFTER_MS,
        latestAt: async (checkDb) => {
          const row = await checkDb.selectFrom("orderbook_levels").select(({ fn }) => fn.max("fetched_at").as("latest")).executeTakeFirst();
          return row?.latest ?? null;
        },
      },
      {
        label: "long_short_ratio",
        staleAfterMs: SLOW_STREAM_STALE_AFTER_MS,
        latestAt: async (checkDb) => {
          const row = await checkDb.selectFrom("long_short_ratio").select(({ fn }) => fn.max("fetched_at").as("latest")).executeTakeFirst();
          return row?.latest ?? null;
        },
      },
      {
        label: "funding_rates(settled)",
        staleAfterMs: SLOW_STREAM_STALE_AFTER_MS,
        latestAt: async (checkDb) => {
          const row = await checkDb
            .selectFrom("funding_rates")
            .select(({ fn }) => fn.max("fetched_at").as("latest"))
            .where("kind", "=", "settled")
            .executeTakeFirst();
          return row?.latest ?? null;
        },
      },
    ];
    tasks.push(startHeartbeat(env.HEALTHCHECK_PING_URL, HEARTBEAT_INTERVAL_MS, db, freshnessChecks));
    logger.info(
      {
        task: "startup",
        heartbeatIntervalMin: HEARTBEAT_INTERVAL_MS / 60_000,
        checks: freshnessChecks.map((c) => c.label),
      },
      "external heartbeat enabled",
    );
  } else {
    logger.info({ task: "startup" }, "external heartbeat disabled (HEALTHCHECK_PING_URL not set)");
  }

  // Guards against a second SIGTERM/SIGINT (double Ctrl+C from an impatient
  // manual operator, a repeated `kill`, or SIGTERM+SIGINT arriving close
  // together during a VPS intervention) re-entering shutdown() while the
  // first call is still in flight — running tasks/liquidations/db teardown
  // twice concurrently is not safe (e.g. LiquidationCollector.stop()'s
  // `ws.closeAll()` on an already-closing socket).
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.info({ task: "shutdown", signal }, "shutdown already in progress, ignoring");
      return;
    }
    shuttingDown = true;
    logger.info({ task: "shutdown", signal }, "received, stopping collectors...");
    try {
      // liquidations.stop() runs CONCURRENTLY with tasks.map(stop), not after
      // it. liquidations.stop() only closes the WS socket and drains a local
      // buffer via `db` (see its own doc comment) — nothing in it depends on
      // Bybit REST, so it must not sit gated behind whichever scheduled task's
      // `fn()` happens to be mid-REST-call. Run strictly after (as this used
      // to), a single hung REST call (bybit-api's axios client defaults to a
      // 5min timeout that exchange/client.ts does not override) could keep the
      // whole chain from ever reaching liquidations.stop(), and RUNBOOK.md's
      // systemd unit sets no TimeoutStopSec override, so systemd's default 90s
      // SIGKILL would very likely land first — losing whatever liquidation
      // rows were still sitting in the BatchBuffer. Running it in parallel
      // means the buffer gets its drain attempt regardless of how long any
      // individual REST-bound task takes to stop.
      //
      // Both are still awaited, not fire-and-forget, and db.destroy() below
      // still waits for both to settle unconditionally — deliberately no
      // forced deadline on that wait. This file's own per-symbol sweep math
      // (ORDERBOOK_CALL_SPACING_MS/LONG_SHORT_CALL_SPACING_MS doc comment
      // above) puts a legitimate, non-hung full sweep's worst case in the same
      // order of magnitude as systemd's 90s window once real REST latency is
      // added on top of the fixed spacing — there is no deadline value here
      // that's both short enough to reliably beat SIGKILL AND long enough to
      // never cut off a healthy in-flight cycle, so forcing one would trade
      // today's silent-SIGKILL failure mode for a self-inflicted
      // db.destroy()-races-a-mid-write one (see ScheduledTask's own doc
      // comment) on a perfectly healthy cycle. SHUTDOWN_WARN_AFTER_MS below is
      // diagnostic only — it never cuts this wait short.
      const shutdownWarnTimer = setTimeout(() => {
        logger.warn(
          { task: "shutdown", signal, warnAfterMs: SHUTDOWN_WARN_AFTER_MS },
          "shutdown still waiting on scheduled tasks/liquidations — a REST call may be hung; " +
            "systemd's default 90s TimeoutStopSec may SIGKILL before this finishes",
        );
      }, SHUTDOWN_WARN_AFTER_MS);
      await Promise.all([Promise.all(tasks.map((task) => task.stop())), liquidations.stop()]);
      clearTimeout(shutdownWarnTimer);
      await db.destroy();
      logger.info({ task: "shutdown" }, "done");
      process.exit(0);
    } catch (e) {
      // There is no process.on("unhandledRejection") anywhere in this process,
      // so letting any of the three awaited steps above reject here would be
      // an unhandled rejection — depending on Node's unhandled-rejection mode
      // that either crashes the process before db.destroy() runs, or leaves
      // it hung with no scheduled work left but the event loop still alive.
      // Logged and exited non-zero instead: systemd sees a real failure, and
      // whatever DID complete above already ran.
      logger.error({ err: e, task: "shutdown" }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Guarded so importing this module (e.g. test/collector.test.ts, to exercise
// assertUniverseNonEmpty in isolation) never triggers a real run against the
// live prod DB/Bybit — only a direct `node .../collector.js` invocation does.
// Same pattern as scripts/runEmulationScenario.ts's own guard.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    logger.error({ err: e, task: "fatal" }, "fatal error");
    process.exit(1);
  });
}
