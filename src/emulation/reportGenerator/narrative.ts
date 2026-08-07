import Big from "big.js";
import { ENTRY_FLOOR_R8H, EXIT_REASON_RU, parseContextBig, type TradeRow } from "./shared.js";

// Narrative (human-readable causality) sub-file of ../reportGenerator.ts —
// see that file's module doc comment for the full picture. Builds
// trades.csv's `narrative` column.
//
// Built ONLY from (a) paper_positions.entry_reasoning/exit_reasoning, parsed
// via parseReasoningText, and (b) this file's own already-computed TradeRow
// P&L components — never a fabricated figure. Any field missing from the
// parsed context (older data, a field that legitimately wasn't collected yet
// at that instant — see scenarioRunner.ts's openInterest/longShortRatio doc
// comments) simply drops that clause from the sentence rather than guessing.

/** `0.0015` -> "0.150%" (fraction -> percent string, fixed decimals). */
function pctStr(fraction: Big, decimals: number): string {
  return `${fraction.times(100).toFixed(decimals)}%`;
}

/** `-0.9` -> "-$0.90", `4.1` -> "+$4.10" — sign always explicit, so a reader never has to infer cost vs. income from context. */
function usdStr(amount: Big): string {
  const sign = amount.gte(0) ? "+" : "-";
  return `${sign}$${amount.abs().toFixed(2)}`;
}

/** Russian noun pluralization (1 -> one, 2-4 -> few, 5-20/0/5-9 -> many), standard genitive-count rule including the 11-14 exception. */
function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * One connected Russian sentence per closed trade, assembled from
 * entry_reasoning (funding rate + long/short skew at entry),
 * exit_reasoning (hold duration's funding-payment count, exit reason code),
 * and this row's own already-computed P&L components (funding/basis/costs/
 * net). Designed for `paper_trades_<run_id>.csv`'s `narrative` column — see
 * module doc comment.
 */
export function buildNarrative(trade: TradeRow): string {
  const sentences: string[] = [];

  // --- Entry: funding rate (vs. the entry floor) + long/short skew ---
  const entryParts: string[] = [];
  const entryR8h = parseContextBig(trade.entryContext, "r8h");
  if (entryR8h !== undefined) {
    let clause = `Вход при funding ${pctStr(entryR8h, 3)}/8ч`;
    if (entryR8h.gt(0)) {
      const multiple = entryR8h.div(ENTRY_FLOOR_R8H);
      clause += ` (в ${multiple.toFixed(1)}× выше порога входа ${pctStr(ENTRY_FLOOR_R8H, 3)})`;
    }
    entryParts.push(clause);
  }
  const buyRatio = parseContextBig(trade.entryContext, "lsrBuyRatio");
  const sellRatio = parseContextBig(trade.entryContext, "lsrSellRatio");
  if (buyRatio !== undefined && sellRatio !== undefined) {
    if (buyRatio.gt(sellRatio) && sellRatio.gt(0)) {
      entryParts.push(`long/short ratio ${buyRatio.div(sellRatio).toFixed(2)} — перекос в лонги`);
    } else if (sellRatio.gt(buyRatio) && buyRatio.gt(0)) {
      entryParts.push(`long/short ratio ${sellRatio.div(buyRatio).toFixed(2)} — перекос в шорты`);
    } else if (buyRatio.eq(sellRatio)) {
      entryParts.push("long/short ratio без выраженного перекоса");
    } else if (buyRatio.gt(sellRatio)) {
      entryParts.push("long/short ratio: 100% лонги (шортов нет) — предельный перекос в лонги");
    } else if (sellRatio.gt(buyRatio)) {
      entryParts.push("long/short ratio: 100% шорты (лонгов нет) — предельный перекос в шорты");
    }
  }
  if (entryParts.length > 0) sentences.push(entryParts.join(", ") + ".");

  // --- Hold duration (TradeRow's own precise figure, not exit_reasoning's rounded text copy) + funding payment count ---
  const holdClause = `Удержана ${trade.holdDurationHours.toFixed(2)}ч`;
  const fundingPaymentsRaw = trade.exitContext.fundingPaymentsCollected;
  const fundingPaymentsCount = fundingPaymentsRaw !== undefined ? Number.parseInt(fundingPaymentsRaw, 10) : undefined;
  if (fundingPaymentsCount !== undefined && Number.isFinite(fundingPaymentsCount)) {
    const noun = ruPlural(fundingPaymentsCount, "выплата", "выплаты", "выплат");
    sentences.push(`${holdClause}, получено ${String(fundingPaymentsCount)} ${noun} funding.`);
  } else {
    sentences.push(`${holdClause}.`);
  }

  // --- Exit reason ---
  const reasonCode = trade.exitContext.reasonCode;
  if (reasonCode !== undefined) {
    const ruReason = EXIT_REASON_RU[reasonCode] ?? reasonCode;
    const liquidationPrice = parseContextBig(trade.exitContext, "liquidationPrice");
    const priceClause = liquidationPrice !== undefined ? ` (цена ликвидации $${liquidationPrice.toFixed(2)})` : "";
    sentences.push(`Закрыта по причине: ${ruReason}${priceClause}.`);
  }

  // --- P&L breakdown, reusing this row's own already-computed components ---
  const costs = trade.feesUsd.plus(trade.slippageUsd).plus(trade.borrowCostUsd);
  const pnlParts = [`funding ${usdStr(trade.fundingUsd)}`];
  if (!trade.basisPnlUsd.eq(0)) pnlParts.push(`базис ${usdStr(trade.basisPnlUsd)}`);
  pnlParts.push(`издержки ${usdStr(costs)}`);
  sentences.push(`Итог: ${usdStr(trade.netPnlUsd)} (${pnlParts.join(", ")}).`);

  return sentences.join(" ");
}
