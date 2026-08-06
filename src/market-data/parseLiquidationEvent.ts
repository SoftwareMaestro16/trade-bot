import { isWsAllLiquidationEvent } from "bybit-api";
import type { Insertable } from "kysely";
import type { Database } from "../storage/schema.js";

/**
 * FR-107, topic `allLiquidation.{symbol}` (the old `liquidation` topic is
 * deprecated since 2025-02-20 — DECISIONS.md ADR-006). Pulled out as a pure
 * function specifically so it can be unit tested without a live WebSocket —
 * see collectLiquidations.ts's own comment on why the class around it is
 * verified by a live smoke check instead of a mocked socket.
 *
 * Returns `null` for anything that is not a liquidation event (the same `update`
 * listener on the shared WS connection will see other topics too, once this
 * collector is composed with others on one socket).
 */
export function parseLiquidationEvent(event: unknown): Insertable<Database["liquidations"]>[] | null {
  if (!isWsAllLiquidationEvent(event)) return null;

  const data = (event as { data: unknown }).data;
  if (!Array.isArray(data)) return [];

  const rows: Insertable<Database["liquidations"]>[] = [];
  for (const item of data) {
    if (!isLiquidationItem(item)) continue;
    rows.push({
      symbol: item.s,
      side: item.S,
      size: item.v,
      price: item.p,
      liquidation_time_ms: String(item.T),
    });
  }
  return rows;
}

interface RawLiquidationItem {
  T: number;
  s: string;
  S: "Buy" | "Sell";
  v: string;
  p: string;
}

function isLiquidationItem(item: unknown): item is RawLiquidationItem {
  if (typeof item !== "object" || item === null) return false;
  const i = item as Record<string, unknown>;
  return (
    typeof i["T"] === "number" &&
    typeof i["s"] === "string" &&
    (i["S"] === "Buy" || i["S"] === "Sell") &&
    typeof i["v"] === "string" &&
    typeof i["p"] === "string"
  );
}
