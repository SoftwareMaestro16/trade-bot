import { WebsocketClient } from "bybit-api";
import type { Insertable, Kysely } from "kysely";
import { BatchBuffer } from "./batchBuffer.js";
import { parseLiquidationEvent } from "./parseLiquidationEvent.js";
import type { Database } from "../storage/schema.js";

export interface LiquidationCollectorOptions {
  testnet: boolean;
  flushBatchSize?: number;
  flushIntervalMs?: number;
}

/**
 * FR-107: WebSocket topic `allLiquidation.{symbol}` (old `liquidation` topic
 * deprecated 2025-02-20 — DECISIONS.md ADR-006).
 *
 * Connection lifecycle (connect, reconnect, resubscribe after a drop) is
 * deliberately delegated to bybit-api's WebsocketClient, which documents
 * automatic resubscribe on reconnect. Phase 1 does not reimplement that: this is
 * read-only market data collection, not the private trading stream — a missed
 * liquidation during a reconnect gap is a missed data point, not a safety
 * incident (contrast with RISK-REGISTER.md FM-22, which is about the trading
 * stream in a later phase, where a missed fill event is a state-corruption risk).
 *
 * Testing note: this class is not unit-tested against a mocked socket — nock
 * only intercepts HTTP, and building a realistic mock WS server is disproportionate
 * effort for Phase 1. What IS unit-tested, thoroughly: the parsing logic
 * (parseLiquidationEvent.test.ts) and the buffering/flush logic (batchBuffer.test.ts).
 * This class itself is verified by a live connection smoke check against testnet
 * during development — confirmed subscription accepted, `update` events for a
 * liquidation topic parse correctly, no exceptions on connect/close.
 */
export class LiquidationCollector {
  private readonly ws: WebsocketClient;
  private readonly buffer: BatchBuffer<Insertable<Database["liquidations"]>>;
  private started = false;

  constructor(db: Kysely<Database>, options: LiquidationCollectorOptions) {
    this.ws = new WebsocketClient({ testnet: options.testnet });
    this.buffer = new BatchBuffer(options.flushBatchSize ?? 200, options.flushIntervalMs ?? 1000, async (rows) => {
      await db.insertInto("liquidations").values(rows).execute();
    });
    this.ws.on("update", (event: unknown) => {
      const rows = parseLiquidationEvent(event);
      if (!rows) return;
      for (const row of rows) this.buffer.push(row);
    });
  }

  start(symbols: string[]): void {
    if (this.started) throw new Error("LiquidationCollector.start() called twice");
    this.started = true;
    const topics = symbols.map((s) => `allLiquidation.${s}`);
    // Not awaited: promiseSubscribeRequests is off (default), and bybit-api's own
    // docs note the returned promises "may not behave as expected" for a topic
    // count this large. Subscription + auto-resubscribe-on-reconnect happens
    // regardless; each promise is still drained to avoid an unhandled-rejection warning.
    for (const p of this.ws.subscribeV5(topics, "linear")) {
      void p.catch(() => {});
    }
  }

  async stop(): Promise<void> {
    // Close the socket BEFORE draining, not after: closing first guarantees no
    // new "update" event can arrive and start another buffered flush while we're
    // waiting, which is exactly the race that used to let a flush started just
    // before shutdown finish (or fail) after the DB pool was already torn down.
    // drain() (not flush()) additionally waits for any flush already in flight
    // from an earlier burst, not just whatever is sitting in the buffer right now.
    this.ws.closeAll();
    await this.buffer.drain();
    this.started = false;
  }
}
