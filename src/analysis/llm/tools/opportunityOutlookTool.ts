import Big from "big.js";
import type { MarketAssessment, PairClassification } from "../../marketAssessment.js";
import { PREMIUM_DRIVEN_THRESHOLD_R8H } from "../../../risk/economics.js";
import { MIN_SIGMAS_TO_STOP } from "../../../risk/basisStability.js";
import { NarratingTool, RUSSIAN_ANALYST_SYSTEM_PROMPT } from "./analysisTool.js";
import type { LlmClient, LlmPrompt } from "../client.js";

/**
 * «Что мешает конкретной ликвидной паре стать торгуемой и насколько далеко до
 * этого». Ликвидность — жёсткий структурный фильтр (объём не растёт по желанию),
 * поэтому near-miss ищется только среди ликвидных пар: у них не хватает либо
 * funding, либо стабильности базиса, и это измеримо.
 */
export interface Blocker {
  symbol: string;
  reason: "funding" | "basis" | "both";
  /** Насколько funding ниже премиального порога, в %/8ч (>0 — если funding блокирует). */
  fundingShortfallPct: Big | null;
  /** Скольких сигм не хватает до требуемого запаса (>0 — если базис блокирует). */
  sigmaShortfall: Big | null;
}

export interface OpportunityOutlook {
  hasOpportunityNow: boolean;
  /** tradeable — есть возможности; close — ликвидная пара в шаге по одному условию; far — иначе. */
  distance: "tradeable" | "close" | "far";
  /** Сколько пар проходят структурный фильтр ликвидности. */
  liquidCandidates: number;
  /** Ближайшие к торгуемости ликвидные near-miss'ы (до 5). */
  closest: Blocker[];
}

// Near-miss считается «близким», если нормированное отставание по единственному
// проваленному условию не больше этого. 0.4 = «в пределах 40% по одной оси».
const CLOSE_DISTANCE_THRESHOLD = 0.4;

/**
 * Инструмент перспективы: детерминированный gap-анализ + словесный прогноз от
 * LLM. Прогноз описывает, ЧТО должно измениться на рынке для появления сделок,
 * и не строит из этого совета входить.
 */
export class OpportunityOutlookTool extends NarratingTool<MarketAssessment, OpportunityOutlook> {
  readonly name = "opportunity_outlook";
  readonly description =
    "Оценивает перспективу заработать: что мешает ликвидным парам стать торгуемыми и близок ли рынок к возможности.";

  constructor(llm: LlmClient) {
    super(llm);
  }

  protected computeData(assessment: MarketAssessment): OpportunityOutlook {
    return computeOutlook(assessment);
  }

  protected buildPrompt(data: OpportunityOutlook): LlmPrompt {
    return {
      system: RUSSIAN_ANALYST_SYSTEM_PROMPT,
      user:
        "Оцени перспективу заработать на рынке в ближайшее время по этим данным. Объясни простыми " +
        "словами, что должно измениться, чтобы появились сделки, и насколько рынок близок к этому.\n\n" +
        formatOutlookFacts(data),
    };
  }
}

function blockerFor(c: PairClassification): { blocker: Blocker; distance: number } | null {
  if (c.isOpportunity) return null;

  const failsFunding = !c.passesFunding;
  const failsBasis = !c.passesBasisStability;

  let fundingShortfallPct: Big | null = null;
  let fundingNorm = 0;
  if (failsFunding) {
    const shortfall = PREMIUM_DRIVEN_THRESHOLD_R8H.minus(c.predictedR8h);
    const clamped = shortfall.gt(0) ? shortfall : new Big(0);
    fundingShortfallPct = clamped.times(100);
    fundingNorm = Number(clamped.div(PREMIUM_DRIVEN_THRESHOLD_R8H).toFixed(6));
  }

  let sigmaShortfall: Big | null = null;
  let basisNorm = 0;
  if (failsBasis) {
    if (c.sigmasToStop === null) {
      // Волатильность неизвестна — считаем максимально далёким по этой оси.
      basisNorm = 1;
    } else {
      const shortfall = MIN_SIGMAS_TO_STOP.minus(c.sigmasToStop);
      const clamped = shortfall.gt(0) ? shortfall : new Big(0);
      sigmaShortfall = clamped;
      basisNorm = Number(clamped.div(MIN_SIGMAS_TO_STOP).toFixed(6));
    }
  }

  const reason: Blocker["reason"] = failsFunding && failsBasis ? "both" : failsFunding ? "funding" : "basis";
  return {
    blocker: { symbol: c.symbol, reason, fundingShortfallPct, sigmaShortfall },
    distance: fundingNorm + basisNorm,
  };
}

export function computeOutlook(assessment: MarketAssessment): OpportunityOutlook {
  const liquid = assessment.classifications.filter((c) => c.passesLiquidity);

  const ranked = liquid
    .map(blockerFor)
    .filter((x): x is { blocker: Blocker; distance: number } => x !== null)
    .sort((a, b) => a.distance - b.distance);

  const hasOpportunityNow = assessment.opportunities.length > 0;
  let distance: OpportunityOutlook["distance"];
  if (hasOpportunityNow) {
    distance = "tradeable";
  } else if (ranked.length > 0 && ranked[0]!.distance <= CLOSE_DISTANCE_THRESHOLD) {
    distance = "close";
  } else {
    distance = "far";
  }

  return {
    hasOpportunityNow,
    distance,
    liquidCandidates: liquid.length,
    closest: ranked.slice(0, 5).map((r) => r.blocker),
  };
}

export function formatOutlookFacts(o: OpportunityOutlook): string {
  const distanceRu =
    o.distance === "tradeable" ? "есть торгуемые возможности" : o.distance === "close" ? "рынок близок" : "рынок далёк";
  const lines: string[] = [
    `Есть возможности прямо сейчас: ${o.hasOpportunityNow ? "да" : "нет"}.`,
    `Ликвидных пар (прошли структурный фильтр объёма): ${String(o.liquidCandidates)}.`,
    `Дистанция до торгуемости: ${distanceRu}.`,
  ];
  if (o.closest.length > 0) {
    lines.push("Ближайшие к торгуемости ликвидные пары и чего им не хватает:");
    for (const b of o.closest) {
      const parts: string[] = [];
      if (b.fundingShortfallPct !== null && b.fundingShortfallPct.gt(0)) {
        parts.push(`funding ниже порога на ${b.fundingShortfallPct.toFixed(3)}%/8ч`);
      }
      if (b.sigmaShortfall !== null && b.sigmaShortfall.gt(0)) {
        parts.push(`не хватает ${b.sigmaShortfall.toFixed(1)} сигм запаса базиса`);
      }
      if (parts.length === 0) parts.push("волатильность базиса неизвестна");
      lines.push(`  - ${b.symbol}: ${parts.join("; ")}.`);
    }
  }
  return lines.join("\n");
}
