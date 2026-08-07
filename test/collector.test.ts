import { describe, expect, it } from "vitest";
import { assertUniverseNonEmpty } from "../src/collector.js";
import type { UniverseSymbol } from "../src/market-data/universe.js";

describe("assertUniverseNonEmpty", () => {
  it("throws when the universe is empty (e.g. an upstream Bybit filter/schema change)", () => {
    expect(() => assertUniverseNonEmpty([])).toThrow(/computeTradeableUniverse returned 0 tradeable symbols/);
  });

  it("does not throw for a single-symbol universe", () => {
    const universe: UniverseSymbol[] = [{ symbol: "BTCUSDT", fundingIntervalMinutes: 480 }];
    expect(() => assertUniverseNonEmpty(universe)).not.toThrow();
  });

  it("does not throw for a realistically-sized universe", () => {
    const universe: UniverseSymbol[] = Array.from({ length: 293 }, (_, i) => ({
      symbol: `SYM${String(i)}USDT`,
      fundingIntervalMinutes: 480,
    }));
    expect(() => assertUniverseNonEmpty(universe)).not.toThrow();
  });
});
