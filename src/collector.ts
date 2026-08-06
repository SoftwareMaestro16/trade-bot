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
import { scheduleDailyAt } from "./notify/dailySchedule.js";
import { formatDigestTable } from "./notify/formatDigest.js";
import { startHeartbeat } from "./notify/healthcheck.js";
import { deliverPending, enqueueRichNotification } from "./notify/notificationQueue.js";
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

// How stale the newest `tickers` row is allowed to be before the heartbeat
// treats the collector as unhealthy and withholds its ping (letting
// healthchecks.io's own "ping didn't arrive" alert fire). TICKER_INTERVAL_MS
// is 60s, so 10 minutes tolerates ~10 consecutive missed cycles — generous
// enough that a single transient Bybit hiccup never false-alarms, tight
// enough that "running but writing nothing" is caught within one HEARTBEAT
// window either way.
const DB_STALE_AFTER_MS = 10 * 60_000;

// notificationQueue.ts's own retry cadence for anything still sitting
// undelivered (Telegram was down, network blip, etc.) — independent of the
// twice-daily digest schedule below, so a queued message doesn't wait up to
// 8 hours for its next retry attempt.
const NOTIFICATION_RETRY_INTERVAL_MS = 15 * 60_000;

interface ScheduledTask {
  /**
   * Resolves once any IN-FLIGHT `fn()` call has finished (and no further one
   * will start) — not merely "no future tick is scheduled." `shutdown()` must
   * await this before tearing down `db`: without it, a cycle that's mid-write
   * when SIGTERM arrives races `db.destroy()`, which fails BOTH the success
   * and the fallback failure UPDATE inside runCollectionCycle (Kysely's pool
   * marks itself destroyed synchronously), leaving that row stuck at
   * status='running' forever — indistinguishable from a real hang.
   */
  stop: () => Promise<void>;
}

/**
 * Runs `fn` repeatedly, waiting `intervalMs` after each run COMPLETES before
 * starting the next — never wall-clock ticks. This makes overlap structurally
 * impossible: a slow cycle simply pushes the next one back instead of racing it,
 * which would otherwise mean two concurrent writers for the same collector.
 *
 * A failure in `fn` is logged and does NOT stop the schedule (deliberately
 * different from RR-50's "unknown exception = halt" in a trading context — Phase 1
 * has no position at risk, so keeping the collector alive through a transient
 * failure serves FR-109's continuity goal better than stopping would; the failure
 * itself is still recorded, via runCollectionCycle writing collection_runs.status='failed').
 */
function scheduleRepeating(name: string, fn: () => Promise<void>, intervalMs: number): ScheduledTask {
  const taskLogger = logger.child({ task: name });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const attempt = (async () => {
      try {
        await fn();
      } catch (e) {
        taskLogger.error({ err: e }, "cycle failed");
      }
    })();
    inFlight = attempt;
    await attempt;
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  timer = setTimeout(() => void tick(), 0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
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
        universe = await computeTradeableUniverse(client);
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
    void deliverPending(db, telegramConfig)
      .then((r) => {
        if (r.delivered > 0 || r.stillFailing > 0) {
          logger.info(
            { task: "startup", delivered: r.delivered, stillFailing: r.stillFailing },
            "flushed pending Telegram queue",
          );
        }
      })
      .catch((e: unknown) => logger.error({ err: e, task: "startup" }, "pending Telegram queue flush failed"));

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
  // separate channel from the Telegram digest above, not a duplicate of it.
  if (env.HEALTHCHECK_PING_URL) {
    tasks.push(startHeartbeat(env.HEALTHCHECK_PING_URL, HEARTBEAT_INTERVAL_MS, db, DB_STALE_AFTER_MS));
    logger.info(
      {
        task: "startup",
        heartbeatIntervalMin: HEARTBEAT_INTERVAL_MS / 60_000,
        dbStaleAfterMin: DB_STALE_AFTER_MS / 60_000,
      },
      "external heartbeat enabled",
    );
  } else {
    logger.info({ task: "startup" }, "external heartbeat disabled (HEALTHCHECK_PING_URL not set)");
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ task: "shutdown", signal }, "received, stopping collectors...");
    // Awaited, not fire-and-forget: db.destroy() below must never run while a
    // cycle is still mid-write (see ScheduledTask.stop's own doc comment).
    await Promise.all(tasks.map((task) => task.stop()));
    await liquidations.stop();
    await db.destroy();
    logger.info({ task: "shutdown" }, "done");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  logger.error({ err: e, task: "fatal" }, "fatal error");
  process.exit(1);
});
