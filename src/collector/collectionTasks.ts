import type { Kysely } from "kysely";
import type { PublicExchangeClient } from "../exchange/client.js";
import type { RateLimiter } from "../exchange/rateLimiter.js";
import { logger as rootLogger } from "../logger.js";
import { collectLongShortRatio } from "../market-data/collectLongShortRatio.js";
import { collectOrderbookSnapshots } from "../market-data/collectOrderbookSnapshots.js";
import { collectSettledFunding } from "../market-data/collectSettledFunding.js";
import { collectTickers } from "../market-data/collectTickers.js";
import { runCollectionCycle } from "../market-data/collectionRun.js";
import type { UniverseSymbol } from "../market-data/universe.js";
import type { Database } from "../storage/schema.js";

// Moved out of collector.ts's main(): these were the four per-collector
// async function bodies passed as the `fn` argument to scheduleRepeating
// ("tickers" / "orderbook" / "long-short-ratio" / "settled-funding"). Each is
// self-contained given explicit (client, db, universe[, rateLimiter])
// parameters instead of closing over main()'s local variables, so each is
// independently testable the same way market-data/collect*.ts's own
// functions already are. collector.ts main() now wires each of these into a
// thin `() => runXCycle(client, db, universe, ...)` closure passed to
// scheduleRepeating — that thin wrapper is what still reads the current
// value of `universe` on every tick, exactly as the inline body used to.
const logger = rootLogger.child({ module: "collector" });

/** Extracted verbatim from collector.ts main()'s "tickers" scheduleRepeating task body. */
export async function runTickersCycle(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
): Promise<void> {
  await runCollectionCycle(db, universe.length, async () => {
    const r = await collectTickers(client, db, universe);
    return { symbolsCollected: r.symbolsCollected };
  });
}

/** Extracted verbatim from collector.ts main()'s "orderbook" scheduleRepeating task body. */
export async function runOrderbookCycle(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
  rateLimiter: RateLimiter,
): Promise<void> {
  await runCollectionCycle(db, universe.length, async () => {
    const r = await collectOrderbookSnapshots(client, db, universe, rateLimiter);
    if (r.failed.length > 0) logger.error({ task: "orderbook", failed: r.failed }, "symbols failed");
    return { symbolsCollected: r.symbolsCollected };
  });
}

/** Extracted verbatim from collector.ts main()'s "long-short-ratio" scheduleRepeating task body. */
export async function runLongShortRatioCycle(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
  rateLimiter: RateLimiter,
): Promise<void> {
  await runCollectionCycle(db, universe.length, async () => {
    const r = await collectLongShortRatio(client, db, universe, rateLimiter);
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
}

/** Extracted verbatim from collector.ts main()'s "settled-funding" scheduleRepeating task body. */
export async function runSettledFundingCycle(
  client: PublicExchangeClient,
  db: Kysely<Database>,
  universe: UniverseSymbol[],
  rateLimiter: RateLimiter,
): Promise<void> {
  await runCollectionCycle(db, universe.length, async () => {
    const r = await collectSettledFunding(client, db, universe, rateLimiter);
    if (r.failed.length > 0) logger.error({ task: "settled-funding", failed: r.failed }, "symbols failed");
    return { symbolsCollected: universe.length - r.failed.length };
  });
}
