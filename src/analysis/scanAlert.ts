import type { MarketAssessment, Suitability } from "./marketAssessment.js";

/**
 * Решение периодического сканера: слать ли алерт «появился шанс заработать».
 * Чистая функция от текущей оценки и ПРОШЛОГО состояния — вся логика анти-спама
 * здесь, чтобы её можно было протестировать без Telegram и без времени.
 *
 * Правило (владелец: «шлёт, когда есть шанс заработать»): алертим только на
 * УЛУЧШЕНИИ в торгуемую зону — когда появились возможности, которых не было, или
 * когда пригодность выросла до благоприятной/сильной. Ухудшение и «всё так же»
 * молчат: сканер сообщает о шансе, а не ведёт репортаж. Один и тот же шанс не
 * дублируется — повторный алерт только если рынок ушёл из зоны и вернулся.
 */

const RANK: Record<Suitability, number> = { unsuitable: 0, marginal: 1, favorable: 2, strong: 3 };

export interface ScanState {
  suitability: Suitability;
  opportunityCount: number;
}

export interface ScanDecision {
  alert: boolean;
  message: string | null;
  /** Всегда текущее состояние — вызывающий сохраняет его для следующего тика. */
  newState: ScanState;
}

function currentState(a: MarketAssessment): ScanState {
  return { suitability: a.suitability, opportunityCount: a.opportunities.length };
}

/**
 * Порог, с которого считаем «есть шанс»: favorable и выше ИЛИ хотя бы одна
 * реальная возможность. marginal сам по себе не будит — это «чуть выше нуля»,
 * не повод дёргать владельца.
 */
function isOpportunityZone(s: ScanState): boolean {
  return s.opportunityCount > 0 || RANK[s.suitability] >= RANK.favorable;
}

export function evaluateScan(assessment: MarketAssessment, prev: ScanState | null): ScanDecision {
  const now = currentState(assessment);
  const nowIn = isOpportunityZone(now);
  const prevIn = prev !== null && isOpportunityZone(prev);

  // Алертим на ВХОДЕ в зону возможностей (из «не-зоны»), либо когда внутри зоны
  // стало заметно лучше (пригодность выросла на ступень ИЛИ прибавились
  // возможности) — это новый, более крупный шанс, о нём стоит сказать.
  let alert = false;
  if (nowIn && !prevIn) {
    alert = true;
  } else if (nowIn && prev !== null) {
    const better = RANK[now.suitability] > RANK[prev.suitability] || now.opportunityCount > prev.opportunityCount;
    if (better) alert = true;
  }

  return { alert, message: alert ? buildAlertMessage(assessment) : null, newState: now };
}

export function buildAlertMessage(a: MarketAssessment): string {
  const lines = [
    "🟢 Рынок стал пригоднее для стратегии — возможно, появился шанс.",
    `Оценка пригодности: ${String(a.suitabilityScore)}/100 (${a.suitability}).`,
    `Пар, проходящих все три условия: ${String(a.opportunities.length)}.`,
  ];
  const best = a.opportunities[0];
  if (best) {
    lines.push(
      `Лучшая: ${best.symbol} — funding ${best.predictedR8h.times(100).toFixed(3)}%/8ч, ` +
        `запас до стопа ${best.sigmasToStop !== null ? best.sigmasToStop.toFixed(1) : "н/д"}σ, ` +
        `потолок дохода ${best.grossMonthlyCeilingPct.toFixed(2)}%/мес (идеализированный).`,
    );
  }
  lines.push("Это НЕ сигнал на вход — решение принимает риск-модуль. Проверь «📈 Рынок» в /menu.");
  return lines.join("\n");
}
