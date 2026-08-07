import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ module: "scheduleRepeating" });

export interface ScheduledTask {
  /**
   * Resolves once any IN-FLIGHT `fn()` call has finished (and no further one
   * will start) — not merely "no future tick is scheduled." collector.ts's
   * `shutdown()` must await this before tearing down `db`: without it, a cycle
   * that's mid-write when SIGTERM arrives races `db.destroy()`, which fails
   * BOTH the success and the fallback failure UPDATE inside runCollectionCycle
   * (Kysely's pool marks itself destroyed synchronously), leaving that row
   * stuck at status='running' forever — indistinguishable from a real hang.
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
 *
 * Sibling of notify/dailySchedule.ts's `scheduleDailyAt` and
 * notify/healthcheck.ts's `startHeartbeat` — same no-overlap /
 * error-swallowing / drain-on-stop shape. Extracted out of collector.ts (where
 * it originated, and where it's still the only caller) into its own module
 * purely so it's independently testable the same way those two already are.
 */
export function scheduleRepeating(name: string, fn: () => Promise<void>, intervalMs: number): ScheduledTask {
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
