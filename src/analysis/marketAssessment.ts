import Big from "big.js";
import { PREMIUM_DRIVEN_THRESHOLD_R8H, ENTRY_FLOOR_R8H } from "../risk/economics.js";
import { MIN_PERP_TURNOVER_24H, MIN_SPOT_TURNOVER_24H } from "../risk/liquidity.js";
import { MIN_SIGMAS_TO_STOP } from "../risk/basisStability.js";
import { BASIS_DIVERGENCE_THRESHOLD } from "../strategy/exitRules.js";

/**
 * Read-only market-suitability assessment: "is now a good time to run the
 * strategy at all, and on what?" It classifies every symbol against the SAME
 * three conditions the entry vetoes enforce, so a "green light" here can never
 * disagree with what checkEntry would actually do — the thresholds are imported
 * from risk/, never re-typed.
 *
 * Purely diagnostic. Nothing here decides an entry (that is risk/index.ts's job
 * and stays deterministic and unit-tested); this only summarises, for the
 * Telegram "Рынок" button and the periodic scanner, whether the market is
 * currently offering anything worth trading. The whole sweep exercise
 * (2026-08-10/11) established WHY all three conditions must hold together:
 *
 *   - liquid majors (BTC/ETH) have funding pinned to Bybit's 0.01%/8h clamp;
 *   - pairs with real funding (GRVT/ZBT/CAP) have a basis 30-40x more volatile,
 *     so the emergency stop cuts them before the first settlement;
 *   - pairs that are both funded and calm (TAC/TRIA) have <$1.5M turnover.
 *
 * A tradeable opportunity is the rare pair clearing all three at once. On the
 * data collected so far there were zero — which is exactly what this assessment
 * should report, honestly, rather than manufacturing a reason to trade.
 */

/** Per-symbol snapshot, gathered from the DB by the caller (see analysis/marketStats.ts). */
export interface SymbolMarketStat {
  symbol: string;
  perpTurnover24h: Big;
  spotTurnover24h: Big;
  /** Predicted next-settlement funding, normalized to the r8h basis. */
  predictedR8h: Big;
  /** (perpMark - spotLast) / spotLast at scan time. */
  currentBasis: Big;
  /** Trailing standard deviation of the basis; null when there is too little history. */
  basisStdDev: Big | null;
}

export interface PairClassification {
  symbol: string;
  passesLiquidity: boolean;
  passesFunding: boolean;
  passesBasisStability: boolean;
  /** All three — the pair checkEntry would actually admit on funding/liquidity/survivability grounds. */
  isOpportunity: boolean;
  predictedR8h: Big;
  /** Standard deviations of room from the current basis to the emergency stop; null when volatility is unknown. */
  sigmasToStop: Big | null;
  /**
   * Gross funding income over a month IF a position were held continuously at
   * this rate, as a percent of NOTIONAL, after the predicted->settled haircut.
   * A ceiling, not a forecast: it assumes 100% utilisation and nets out nothing
   * (fees, basis moves, the fact that funding rarely holds for a month). Real
   * net is far lower — see the sweep reports. Present it labelled as a ceiling.
   */
  grossMonthlyCeilingPct: Big;
}

export type Suitability = "unsuitable" | "marginal" | "favorable" | "strong";

export interface MarketAssessment {
  scannedSymbols: number;
  classifications: PairClassification[];
  /** Pairs clearing all three conditions, best funding first. */
  opportunities: PairClassification[];
  /** Passes liquidity + funding but fails basis stability — the "looks good, will get stopped out" trap. */
  fundedButVolatile: number;
  /** Passes liquidity + basis but funding is too weak — the calm-major case. */
  liquidButUnfunded: number;
  /** 0-100. 0 when nothing is tradeable; rises with the count and quality of opportunities. */
  suitabilityScore: number;
  suitability: Suitability;
}

// 3 settlements/day * 30 days. The month-scale figure is a ceiling only (see
// grossMonthlyCeilingPct), so an approximate month length is deliberate.
const SETTLEMENTS_PER_MONTH = 90;

// Matches DEFAULT_FUNDING_REALIZATION_FACTOR but re-declared rather than
// imported: this is a ceiling estimate for a human-facing label, and coupling a
// display figure to the veto's own constant would invite "fix" edits to one
// that silently change the other. If they should track, that is a deliberate
// future decision, not an accident.
const DISPLAY_REALIZATION_FACTOR = new Big("0.65");

function classifyPair(stat: SymbolMarketStat): PairClassification {
  const passesLiquidity =
    stat.perpTurnover24h.gte(MIN_PERP_TURNOVER_24H) && stat.spotTurnover24h.gte(MIN_SPOT_TURNOVER_24H);

  // Both gates the funding side of checkEntry applies: premium-driven (not
  // pinned to the clamp) AND above the raw entry floor. isPremiumDriven's
  // 0.05% bar is the binding one, but checking the floor too keeps this
  // classification identical to the veto rather than merely close to it.
  const passesFunding =
    stat.predictedR8h.gt(PREMIUM_DRIVEN_THRESHOLD_R8H) && stat.predictedR8h.gte(ENTRY_FLOOR_R8H);

  let sigmasToStop: Big | null = null;
  let passesBasisStability = false;
  if (stat.basisStdDev !== null && stat.basisStdDev.gt(0)) {
    const room = BASIS_DIVERGENCE_THRESHOLD.minus(stat.currentBasis.abs());
    if (room.gt(0)) {
      sigmasToStop = room.div(stat.basisStdDev);
      passesBasisStability = sigmasToStop.gte(MIN_SIGMAS_TO_STOP);
    } else {
      sigmasToStop = new Big(0);
    }
  }

  const grossMonthlyCeilingPct = stat.predictedR8h
    .times(DISPLAY_REALIZATION_FACTOR)
    .times(SETTLEMENTS_PER_MONTH)
    .times(100);

  return {
    symbol: stat.symbol,
    passesLiquidity,
    passesFunding,
    passesBasisStability,
    isOpportunity: passesLiquidity && passesFunding && passesBasisStability,
    predictedR8h: stat.predictedR8h,
    sigmasToStop,
    grossMonthlyCeilingPct,
  };
}

/**
 * Maps the best available opportunity's gross monthly ceiling onto 0-100.
 * Deliberately dominated by whether ANY opportunity exists: zero opportunities
 * is zero, not "a little bit suitable", because the sweep showed trading the
 * near-misses loses money every time. Among real opportunities, ~9% monthly
 * ceiling (0.1%/8h sustained) saturates the scale — that is already an
 * optimistic rate for this strategy.
 */
function scoreFrom(opportunities: PairClassification[]): number {
  if (opportunities.length === 0) return 0;
  const bestCeiling = opportunities.reduce(
    (max, o) => (o.grossMonthlyCeilingPct.gt(max) ? o.grossMonthlyCeilingPct : max),
    new Big(0),
  );
  // 9% ceiling -> 100. Linear, clamped.
  const scaled = bestCeiling.div(9).times(100);
  const clamped = scaled.gt(100) ? new Big(100) : scaled;
  // A second opportunity is worth a little, but presence matters far more than
  // count — cap the count bonus so it can never turn a weak edge into a strong
  // reading. +5 per extra opportunity, up to +15.
  const countBonus = Math.min(15, (opportunities.length - 1) * 5);
  const total = Number(clamped.toFixed(1)) + countBonus;
  return Math.min(100, Math.round(total));
}

function suitabilityFrom(score: number): Suitability {
  if (score <= 0) return "unsuitable";
  if (score < 25) return "marginal";
  if (score < 60) return "favorable";
  return "strong";
}

export function assessMarket(stats: readonly SymbolMarketStat[]): MarketAssessment {
  const classifications = stats.map(classifyPair);
  const opportunities = classifications
    .filter((c) => c.isOpportunity)
    .sort((a, b) => b.predictedR8h.cmp(a.predictedR8h));

  const fundedButVolatile = classifications.filter(
    (c) => c.passesLiquidity && c.passesFunding && !c.passesBasisStability,
  ).length;
  const liquidButUnfunded = classifications.filter(
    (c) => c.passesLiquidity && !c.passesFunding,
  ).length;

  const suitabilityScore = scoreFrom(opportunities);

  return {
    scannedSymbols: stats.length,
    classifications,
    opportunities,
    fundedButVolatile,
    liquidButUnfunded,
    suitabilityScore,
    suitability: suitabilityFrom(suitabilityScore),
  };
}
