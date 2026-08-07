import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";

/**
 * RUNBOOK.md §4: an external "dead man's switch" — a third-party service
 * (healthchecks.io or equivalent) alerts the owner if a ping doesn't arrive
 * within an expected window, catching exactly the failure mode nothing
 * INSIDE this process can catch: the whole process hanging, crashing
 * without a working restart path, or losing network entirely — in which
 * case it can't even send its own Telegram alert. RUNBOOK.md §4's documented
 * fallback ("зайти и проверить руками") assumes someone is actively
 * checking; this doesn't. Deliberately a separate channel from the Telegram
 * digest: RISK-REGISTER.md's own two-independent-paths kill switch design
 * applies equally here — a monitoring signal that shares a failure mode with
 * the thing it's monitoring isn't really independent monitoring.
 *
 * Owner's own worry, verbatim: "а то вдруг работает и нихуя не пишется" (what
 * if it's running but writing nothing) — a process whose event loop is fine
 * but whose DB writes are all silently failing (dead connection, disk full,
 * permissions, or a bug in one specific collector's own code) would still
 * "look alive" to a ping-only heartbeat. So this ALSO checks that every
 * INDEPENDENTLY-scheduled collector actually has a recent row before pinging
 * — not just the fastest one. `collector.ts`'s own scheduleRepeating tasks
 * each run on their own timer with their own try/catch (see that file's doc
 * comment on error-swallowing keeping the schedule alive after a single
 * cycle's failure): a bug that makes exactly ONE of them silently write zero
 * rows forever, while its own cycle still "completes" without throwing,
 * would never surface in any of the OTHER tasks' behavior — so checking only
 * `tickers` (as this file used to) would miss it entirely. `tickers`,
 * `funding_rates(kind='predicted')`, and `open_interest` are written
 * together in one INSERT batch by market-data/collectTickers.ts (same
 * collector.ts "tickers" task) — checking `tickers` alone already covers all
 * three, so they are NOT three separate checks below, just one. What DOES
 * need its own check: `orderbook_levels` (collector.ts "orderbook" task),
 * `long_short_ratio` ("long-short-ratio" task), and `funding_rates(kind=
 * 'settled')` ("settled-funding" task) — three genuinely independent write
 * paths tickers freshness says nothing about.
 *
 * `liquidations` is deliberately NOT one of these checks: it's written by a
 * WebSocket subscription (market-data/collectLiquidations.ts), not a polled
 * scheduleRepeating cycle — a quiet market can legitimately produce zero
 * liquidation events for a long stretch, and treating "no new liquidation
 * rows" the same as "no new ticker rows" would false-alarm on market
 * conditions, not bugs. Its failure mode (a dropped/never-reconnecting WS
 * subscription) isn't a data-freshness question at all and would need a
 * different kind of check (connection-state, not row-timestamp) to catch
 * correctly — not built here to avoid conflating two different problems.
 *
 * This module only pings a URL on a timer. Provisioning the actual
 * account/URL at the third-party service is a human step this code
 * deliberately does not attempt — the caller (collector.ts) only starts this
 * when HEALTHCHECK_PING_URL is configured; unset, this never runs at all.
 */

export interface HeartbeatHandle {
  /** Resolves once any in-flight ping has actually finished, not merely once no further one will start. */
  stop: () => Promise<void>;
}

/**
 * One independently-scheduled data stream's own freshness rule. `latestAt`
 * is injected (not hardcoded per-table inside this file) so this module
 * stays decoupled from collector.ts's own table-specific query shapes (e.g.
 * the `kind='settled'` filter on `funding_rates`) and so each check is
 * independently unit-testable without a real scheduler running.
 */
export interface FreshnessCheck {
  /** Used only in log output — e.g. "orderbook_levels", "funding_rates(settled)". */
  label: string;
  /** How old the newest row for this check is allowed to be before it counts as stale. */
  staleAfterMs: number;
  /** Resolves the newest relevant row's timestamp, or null if there are none at all. */
  latestAt: (db: Kysely<Database>) => Promise<Date | null>;
}

/**
 * True iff EVERY check in `checks` has a row newer than its own
 * `staleAfterMs`. A single failing check is enough to withhold the ping —
 * see this module's own doc comment for why a partial failure (one collector
 * silently broken, the rest fine) must not look healthy from the outside.
 * A query failure (DB down, connection dropped) for ANY check also counts as
 * unhealthy — fails closed, same direction as every other risk check in this
 * codebase: when in doubt about whether the collector is actually working,
 * withhold the ping rather than assume the best.
 */
async function checkAllFresh(db: Kysely<Database>, checks: readonly FreshnessCheck[]): Promise<boolean> {
  let allFresh = true;
  for (const check of checks) {
    try {
      const latest = await check.latestAt(db);
      if (!latest || Date.now() - latest.getTime() >= check.staleAfterMs) {
        console.error(`[heartbeat] ${check.label} stale beyond ${check.staleAfterMs}ms — withholding ping`);
        allFresh = false;
      }
    } catch (e) {
      console.error(`[heartbeat] ${check.label} freshness query failed:`, e instanceof Error ? e.message : e);
      allFresh = false;
    }
  }
  return allFresh;
}

/**
 * Pings `pingUrl` every `intervalMs`, starting immediately — but only when
 * EVERY check in `checks` currently reports fresh data (see checkAllFresh).
 * A failed ping (network error or non-2xx) and a withheld ping (any stale/
 * failing check) are both logged locally but never thrown — a heartbeat that
 * can crash the process it's monitoring would defeat its own purpose, and
 * the absence of a ping IS the signal the external service acts on; this
 * function's job is only to attempt delivery when warranted, not to
 * guarantee it.
 */
export function startHeartbeat(
  pingUrl: string,
  intervalMs: number,
  db: Kysely<Database>,
  checks: readonly FreshnessCheck[],
): HeartbeatHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const attempt = (async () => {
      try {
        const fresh = await checkAllFresh(db, checks);
        if (!fresh) return;
        const response = await fetch(pingUrl);
        if (!response.ok) {
          console.error(`[heartbeat] ping responded HTTP ${response.status}`);
        }
      } catch (e) {
        console.error("[heartbeat] ping failed:", e instanceof Error ? e.message : e);
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
