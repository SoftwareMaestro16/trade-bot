export interface DailyScheduleTask {
  /**
   * Resolves once every currently in-flight `fn()` call (there can be more
   * than one — each hour in `hoursUtc` schedules independently) has actually
   * finished, not merely once no further firing will start. Mirrors
   * collector.ts's ScheduledTask.stop() and BatchBuffer.drain() for the same
   * reason: a caller tearing down a resource `fn` depends on (e.g. sending
   * the Telegram digest via a DB-backed stats query) right after calling
   * stop() must not race a firing that was already in progress.
   */
  stop: () => Promise<void>;
}

/**
 * Fixed UTC hours, not local time — Node's `Date` has no reliable way to
 * target a specific IANA zone without a library this project hasn't taken on
 * (a real one would matter for zones with DST; it doesn't for Moscow, which
 * has used a fixed UTC+3 offset with no DST since 2014 — the caller converts
 * once, at the call site, and that conversion is what's visible/correctable,
 * not buried inside this function).
 */
export function msUntilNextUtcTime(hourUtc: number, minuteUtc: number, now: Date): number {
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new RangeError(`hourUtc must be an integer 0-23, got ${hourUtc}`);
  }
  if (!Number.isInteger(minuteUtc) || minuteUtc < 0 || minuteUtc > 59) {
    throw new RangeError(`minuteUtc must be an integer 0-59, got ${minuteUtc}`);
  }

  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Fires `fn` once at each of `hoursUtc` (same `minuteUtc` for all), every day,
 * indefinitely, until `stop()`. A failure in `fn` is logged and does NOT
 * cancel future firings — same reasoning as collector.ts's `scheduleRepeating`:
 * a digest that fails to send once is not a reason to stop sending it forever,
 * and RR-50's "no swallowed exceptions" is about the trading path, not a
 * best-effort status notification.
 */
export function scheduleDailyAt(
  hoursUtc: number[],
  minuteUtc: number,
  fn: () => Promise<void>,
  now: () => Date = () => new Date(),
): DailyScheduleTask {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const inFlight = new Set<Promise<void>>();

  const scheduleOne = (hourUtc: number): void => {
    if (stopped) return;
    const delay = msUntilNextUtcTime(hourUtc, minuteUtc, now());
    const timer = setTimeout(() => {
      if (stopped) return;
      const attempt = (async () => {
        try {
          await fn();
        } catch (e) {
          console.error(`[daily-schedule] fn failed for ${String(hourUtc)}:${String(minuteUtc)} UTC:`, e);
        }
        if (!stopped) scheduleOne(hourUtc);
      })();
      inFlight.add(attempt);
      void attempt.finally(() => inFlight.delete(attempt));
    }, delay);
    timers.push(timer);
  };

  for (const hourUtc of hoursUtc) {
    scheduleOne(hourUtc);
  }

  return {
    stop: async () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      await Promise.all(inFlight);
    },
  };
}
