import Big from "big.js";
import { allow, deny } from "./types.js";
import type { VetoResult } from "./types.js";

/**
 * Вето на вход в пару с запланированным делистингом. Держать дельта-нейтральную
 * позицию ради funding в паре, которую вот-вот снимут с торгов и принудительно
 * рассчитают, — прямой путь к убытку: до бесконечности funding не собрать, а на
 * settlement позицию закроют по чужой цене.
 *
 * Сигнал ДЕТЕРМИНИРОВАННЫЙ, от биржи, не от разбора новостей LLM: у обычного
 * перпетуала instruments-info.deliveryTime == 0; когда назначен делистинг/
 * поставка, туда проставляется реальная метка времени (проверено 2026-08-11:
 * VANRYUSDT под делистинг -> deliveryTime=1786525200000, BTCUSDT -> 0). Именно
 * это поле — авторитет по делистингу; анонсы Bybit в текстовом виде идут только
 * в описание для человека (market-data/announcements.ts), не в это вето.
 *
 * Exit-сторона (strategy/exitRules.ts, DELISTED_OR_CONTRACT_CHANGED) уже
 * существует — это её недостающая ENTRY-пара: не входить туда, откуда придётся
 * экстренно выходить.
 */

/** По умолчанию блокируем вход, если делистинг в пределах 45 дней. Реальные анонсы Bybit — за 1-3 недели, это запас. */
export const DEFAULT_DELISTING_BLOCK_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * `deliveryTimeMs` — instruments-info.deliveryTime (мс). 0 у нормального
 * перпетуала. Ненулевое = назначены делистинг/поставка.
 *
 * Прошедшая метка (deliveryTimeMs < nowMs) тоже DENY: пара уже на выходе/снята.
 * Нечисловой вход (parsing upstream сломался) — fail closed, как в
 * checkFundingBlackout: не знаем — не входим.
 */
export function checkDelisting(
  deliveryTimeMs: number,
  nowMs: number,
  blockWithinMs: number = DEFAULT_DELISTING_BLOCK_WINDOW_MS,
): VetoResult {
  if (!Number.isFinite(deliveryTimeMs) || !Number.isFinite(nowMs)) {
    return deny(
      "DELISTING_TIME_UNKNOWN",
      `Не удалось определить время делистинга (deliveryTimeMs=${String(deliveryTimeMs)}, nowMs=${String(nowMs)}) — ` +
        "вход заблокирован (fail closed).",
    );
  }
  // 0 (или отрицательное как явный «нет метки») — обычный перпетуал.
  if (deliveryTimeMs <= 0) return allow();

  const msToDelisting = deliveryTimeMs - nowMs;
  if (msToDelisting <= blockWithinMs) {
    const days = new Big(Math.max(0, msToDelisting)).div(24 * 60 * 60 * 1000).toFixed(1);
    return deny(
      "DELISTING_SCHEDULED",
      `У пары назначен делистинг/поставка через ${days} дн. (deliveryTime=${String(deliveryTimeMs)}) — ` +
        "новые входы заблокированы: позицию закроют на settlement, funding до тех пор не окупится.",
    );
  }
  return allow();
}
