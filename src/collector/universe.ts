import type { PublicExchangeClient } from "../exchange/client.js";
import { logger as rootLogger } from "../logger.js";
import { computeTradeableUniverse } from "../market-data/universe.js";
import type { UniverseSymbol } from "../market-data/universe.js";

// Moved out of collector.ts (see that file's own doc comment above main()) as
// part of splitting collector.ts's inline scheduleRepeating task bodies into
// separately testable functions. Re-exported from collector.ts via barrel so
// every existing import of `assertUniverseNonEmpty` (test/collector.test.ts)
// keeps resolving unchanged.
const logger = rootLogger.child({ module: "collector" });

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

/**
 * Extracted verbatim from collector.ts main()'s "universe-refresh"
 * scheduleRepeating task body. Deliberately does NOT close over (or reassign)
 * the caller's `universe` variable — it just returns the refreshed value, and
 * the caller (collector.ts main()) does `universe = await refreshUniverse(client)`
 * itself. This preserves the original ordering exactly: assertUniverseNonEmpty
 * runs (and can throw) BEFORE any reassignment happens, same as the inline
 * version where `universe = refreshed` only ran after assertUniverseNonEmpty
 * returned without throwing.
 */
export async function refreshUniverse(client: PublicExchangeClient): Promise<UniverseSymbol[]> {
  const refreshed = await computeTradeableUniverse(client);
  assertUniverseNonEmpty(refreshed);
  logger.info({ task: "universe-refresh", universeSymbols: refreshed.length }, "universe refreshed");
  return refreshed;
}
