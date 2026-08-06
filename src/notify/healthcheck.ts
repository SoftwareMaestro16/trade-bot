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
 * permissions) would still "look alive" to a ping-only heartbeat. So this
 * ALSO checks that `tickers` actually has a recent row before pinging: no
 * fresh row means no ping, which means healthchecks.io's own "ping didn't
 * arrive" alert fires — same external channel, now covering a second,
 * genuinely different failure mode. `tickers` specifically because it's the
 * highest-frequency collector (60s cadence, market-data/collectTickers.ts) —
 * the fastest table to go stale if writes stop for any reason.
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
 * True iff `tickers` has a row fetched within the last `staleAfterMs`. A
 * query failure (DB down, connection dropped) also counts as unhealthy —
 * fails closed, the same direction as every other risk check in this
 * codebase: when in doubt about whether the collector is actually working,
 * withhold the ping rather than assume the best.
 */
async function isDataFresh(db: Kysely<Database>, staleAfterMs: number): Promise<boolean> {
  try {
    const row = await db
      .selectFrom("tickers")
      .select(({ fn }) => fn.max("fetched_at").as("latest"))
      .executeTakeFirst();
    if (!row?.latest) return false;
    return Date.now() - new Date(row.latest).getTime() < staleAfterMs;
  } catch (e) {
    console.error("[heartbeat] DB freshness check failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Pings `pingUrl` every `intervalMs`, starting immediately — but only when
 * `db`'s `tickers` table has a row newer than `staleAfterMs`. A failed ping
 * (network error or non-2xx) and a withheld ping (stale data) are both
 * logged locally but never thrown — a heartbeat that can crash the process
 * it's monitoring would defeat its own purpose, and the absence of a ping IS
 * the signal the external service acts on; this function's job is only to
 * attempt delivery when warranted, not to guarantee it.
 */
export function startHeartbeat(
  pingUrl: string,
  intervalMs: number,
  db: Kysely<Database>,
  staleAfterMs: number,
): HeartbeatHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const attempt = (async () => {
      try {
        const fresh = await isDataFresh(db, staleAfterMs);
        if (!fresh) {
          console.error(`[heartbeat] tickers stale beyond ${staleAfterMs}ms — withholding ping`);
          return;
        }
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
