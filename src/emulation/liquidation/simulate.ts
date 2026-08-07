import Big from "big.js";
import type { DeltaNeutralLiquidationInput } from "./prices.js";
import { computeDeltaNeutralPerpLegLiquidation } from "./prices.js";

/**
 * Forced-liquidation simulation over a historical mark-price series — split
 * out of `../liquidation.ts` (see that file's own top-level doc comment for
 * full citation sources 1-8, which this section's comments below reference by
 * number).
 */

// ---------------------------------------------------------------------------
// Forced-liquidation simulation over a historical mark-price series
// ---------------------------------------------------------------------------

export type PositionSide = "long" | "short";

/**
 * One mark-price observation. Deliberately minimal (not market-data/types.ts's
 * full `SymbolSnapshot`, which also carries orderbook levels, funding, and
 * turnover this simulation doesn't need) but matches that type's own field
 * naming/units convention: `markPrice: Big` (SymbolSnapshot.markPrice) and an
 * epoch-milliseconds timestamp field (SymbolSnapshot.nextFundingTimeMs) — so a
 * caller building this array from market-data/'s stored history does not have
 * to invent new field names or unit conventions for the same underlying data.
 *
 * `markPrice` specifically, not last-traded price: source 1 ("Trading Rules:
 * Liquidation Process") states "Liquidation is triggered by the Mark Price,
 * not the Last Traded Price (LTP)." A caller feeding a last-traded-price
 * series into this simulation would silently mis-time (or entirely miss) a
 * liquidation — this is the one input this module cannot validate for the
 * caller, since a `Big` price alone doesn't say which kind it is.
 */
export interface MarkPriceTick {
  timestampMs: number;
  markPrice: Big;
}

export interface LiquidationSimulationResult {
  wasLiquidated: boolean;
  /** The tick whose markPrice first crossed the liquidation price, if any. */
  liquidationTick?: MarkPriceTick;
  /** Index into the input `ticks` array of `liquidationTick`, if any — for callers that need to slice the series at the liquidation point. */
  liquidationTickIndex?: number;
}

/**
 * Walks `ticks` in order and reports the first tick (if any) whose markPrice
 * reaches or crosses `liquidationPrice` in the direction that liquidates
 * `side` — source 1: "liquidation will be triggered when the Mark Price hits
 * the position's Liquidation Price" (hits, i.e. the boundary itself counts:
 * `>=`/`<=`, not a strict inequality — same inclusive-boundary convention
 * risk/leverage.ts's own `checkAccountMMRate` uses at its own threshold).
 *
 * A SHORT position loses as price rises (liquidation price sits ABOVE entry —
 * see `computeLiquidationPriceShort`'s numerator, entirely `+` terms added to
 * entry×qty), so the crossing direction for `side: "short"` is markPrice
 * reaching UP to `liquidationPrice`; for `side: "long"` it is the mirror,
 * markPrice falling DOWN to it.
 *
 * `ticks` MUST already be sorted ascending by `timestampMs` — this function
 * throws rather than silently re-sorting or returning a wrong "first"
 * crossing, per PROJECT.md ТАБУ #10 ("ни одного проглоченного исключения"):
 * a caller passing an unsorted series has a real bug upstream (e.g. two
 * merged history pages in the wrong order) that a silent sort would hide.
 * Once liquidated, later ticks are never inspected — a real liquidation ends
 * the position, so any subsequent price recovery is irrelevant to whether
 * (and when) forced closure happened.
 */
export function simulateForcedLiquidation(
  ticks: readonly MarkPriceTick[],
  liquidationPrice: Big,
  side: PositionSide,
): LiquidationSimulationResult {
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    if (i > 0 && tick.timestampMs < ticks[i - 1]!.timestampMs) {
      throw new RangeError(
        `ticks must be sorted ascending by timestampMs — tick[${i}].timestampMs=${tick.timestampMs} is before tick[${i - 1}].timestampMs=${ticks[i - 1]!.timestampMs}`,
      );
    }

    const crossed = side === "short" ? tick.markPrice.gte(liquidationPrice) : tick.markPrice.lte(liquidationPrice);
    if (crossed) {
      return { wasLiquidated: true, liquidationTick: tick, liquidationTickIndex: i };
    }
  }

  return { wasLiquidated: false };
}

/**
 * Convenience integration of `computeDeltaNeutralPerpLegLiquidation` and
 * `simulateForcedLiquidation`: given the perp leg's entry/margin parameters
 * and a historical mark-price series, reports whether (and when) the perp
 * leg — and with it, the pair's delta-neutrality (see this module's top-level
 * "SCOPE" doc comment) — would have been forcibly closed. Always simulates
 * `side: "short"`, matching `computeDeltaNeutralPerpLegLiquidation`'s own
 * fixed side.
 *
 * `ticks` should start at/after the position's entry instant — this function
 * does not filter by entry time itself (same "caller scopes the input, this
 * function is a pure per-call computation" convention emulation/equityEngine.ts's
 * own doc comment states explicitly for its own per-tick snapshot function).
 */
export function simulateDeltaNeutralForcedLiquidation(
  ticks: readonly MarkPriceTick[],
  input: DeltaNeutralLiquidationInput,
): LiquidationSimulationResult & { perpLiquidationPrice: Big } {
  const { perpLiquidationPrice } = computeDeltaNeutralPerpLegLiquidation(input);
  const result = simulateForcedLiquidation(ticks, perpLiquidationPrice, "short");
  return { ...result, perpLiquidationPrice };
}
