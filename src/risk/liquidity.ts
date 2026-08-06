import Big from "big.js";
import { allow, deny } from "./types.js";
import type { VetoResult } from "./types.js";
import type { OrderbookLevel } from "../market-data/types.js";

const MIN_PERP_TURNOVER_24H = new Big("100000000"); // PARAMS-CONSERVATIVE.md §4
const MIN_SPOT_TURNOVER_24H = new Big("20000000");
const MAX_SLIPPAGE_BP = new Big("0.0005"); // PARAMS-CONSERVATIVE.md §6, 0.05% per leg

/**
 * RR-23 (SRS.md) / PARAMS-CONSERVATIVE.md §4: perp and spot thresholds are both
 * required, independently — RISK-REGISTER.md FM-03 found the SPOT book is
 * usually the binding liquidity constraint even when the perp book looks deep,
 * so screening on perp turnover alone (a common mistake) would systematically
 * admit symbols that cannot actually be exited cheaply.
 */
export function checkTurnover(perpTurnover24h: Big, spotTurnover24h: Big): VetoResult {
  if (perpTurnover24h.lt(MIN_PERP_TURNOVER_24H)) {
    return deny(
      "PERP_TURNOVER_TOO_LOW",
      `Perp 24h turnover ${perpTurnover24h.toString()} is below the ${MIN_PERP_TURNOVER_24H.toString()} USDT floor (PARAMS-CONSERVATIVE.md §4).`,
    );
  }
  if (spotTurnover24h.lt(MIN_SPOT_TURNOVER_24H)) {
    return deny(
      "SPOT_TURNOVER_TOO_LOW",
      `Spot 24h turnover ${spotTurnover24h.toString()} is below the ${MIN_SPOT_TURNOVER_24H.toString()} USDT floor (PARAMS-CONSERVATIVE.md §4).`,
    );
  }
  return allow();
}

export interface SlippageEstimate {
  slippageBp: Big;
  filledNotional: Big;
  exhausted: boolean;
}

/**
 * RISK-REGISTER.md FM-03: walks the provided book (best price first) to fill
 * `targetNotional`, measuring slippage against the best price rather than a
 * separately-supplied mid — the caller passes whichever side's book is being
 * consumed (asks to buy, bids to sell).
 *
 * `exhausted: true` when the book cannot fill the full notional — the caller
 * MUST treat this as an explicit failure (RISK-REGISTER.md: "исчерпание
 * глубины возвращает явную ошибку, не частичную оценку"), never silently
 * accept the partial fill as if it were the real cost.
 */
export function estimateSlippage(levels: OrderbookLevel[], targetNotional: Big): SlippageEstimate {
  if (levels.length === 0) {
    return { slippageBp: new Big(0), filledNotional: new Big(0), exhausted: true };
  }

  const bestPrice = levels[0]!.price;
  let filledNotional = new Big(0);
  let filledQty = new Big(0);
  let remaining = targetNotional;

  for (const level of levels) {
    if (remaining.lte(0)) break;
    const levelNotional = level.price.times(level.qty);
    const takeNotional = levelNotional.lt(remaining) ? levelNotional : remaining;
    filledQty = filledQty.plus(takeNotional.div(level.price));
    filledNotional = filledNotional.plus(takeNotional);
    remaining = remaining.minus(takeNotional);
  }

  const exhausted = filledNotional.lt(targetNotional);
  if (filledNotional.eq(0)) {
    return { slippageBp: new Big(0), filledNotional, exhausted };
  }

  const averageFillPrice = filledNotional.div(filledQty);
  const slippageBp = averageFillPrice.minus(bestPrice).div(bestPrice).abs();

  return { slippageBp, filledNotional, exhausted };
}

/**
 * PARAMS-CONSERVATIVE.md §6: 0.05% per leg is a hard ceiling — excess means
 * refusing the entry, never executing at the worse price.
 */
export function checkSlippage(estimate: SlippageEstimate): VetoResult {
  if (estimate.exhausted) {
    return deny(
      "ORDERBOOK_DEPTH_EXHAUSTED",
      "Order book depth insufficient to fill the target notional (RISK-REGISTER.md FM-03).",
    );
  }
  if (estimate.slippageBp.gt(MAX_SLIPPAGE_BP)) {
    return deny(
      "SLIPPAGE_TOO_HIGH",
      `Estimated slippage ${estimate.slippageBp.toString()} exceeds the ${MAX_SLIPPAGE_BP.toString()} per-leg ceiling (PARAMS-CONSERVATIVE.md §6).`,
    );
  }
  return allow();
}
