import Big from "big.js";
import type { DeltaNeutralLiquidationInput, MarginTier } from "../liquidation.js";

/**
 * scenarioRunner split (mechanical refactor): constants, public types, and
 * internal types shared across the scenarioRunner/ sub-files. See
 * ../../emulation/scenarioRunner.ts (the barrel) for this module's own
 * top-level doc comment (look-ahead discipline, RR-22, documented
 * simplifications) — that overview doc still applies to every file in this
 * folder and is not duplicated here.
 */

// ---------------------------------------------------------------------------
// Fallback constants — every one is a documented, overridable default, never a
// silently-assumed truth. See ScenarioConfig fields for how to override.
// ---------------------------------------------------------------------------

/** No instruments-info table in this schema — see module doc comment. */
export const DEFAULT_PERP_QTY_STEP = new Big("0.001");

/** RR-26 fallback convention (VIP0). PARAMS-CONSERVATIVE.md §6: spot maker=taker on VIP0, 0.10%. */
export const SPOT_TAKER_FEE_RATE_FALLBACK = new Big("0.001");

/** RR-26 fallback convention (VIP0). risk/economics.ts's own comment: perp taker ~0.055%. */
export const PERP_TAKER_FEE_RATE_FALLBACK = new Big("0.00055");

/** emulation/borrowCost.ts's own cited live VIP0 snapshot (RISK-REGISTER.md FM-09), not a pinned production value. */
export const HOURLY_BORROW_RATE_FALLBACK = new Big("0.0000044069");

/** PARAMS-CONSERVATIVE.md §5: "круг комиссий должен окупаться за ≤ 3 суток". */
export const EXPECTED_PAYBACK_MINUTES = new Big(3 * 24 * 60);

export const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScenarioConfig {
  name: string;
  /** Perp leg's OWN margin leverage (1.0 = fully self-funded, no borrowing) — NOT the same quantity as risk/leverage.ts's "effective leverage" (shortNotional/totalEquity), see module doc comment. */
  leverage: Big;
  startingDeposit: Big;
  /** Tradeable universe for this scenario — assumed pre-curated (no Innovation/Adventure Zone symbols), see module doc comment. */
  symbols: string[];
  startAt: Date;
  endAt: Date;
  perpQtyStepBySymbol?: Record<string, Big>;
  hourlyBorrowRate?: Big;
  spotTakerFeeRate?: Big;
  perpTakerFeeRate?: Big;
  /** Fixed target notional per leg, overriding the equity-fraction default — see module doc comment's "Position sizing". */
  positionSizeUsd?: Big;
}

export interface ScenarioRunResult {
  scenarioId: bigint;
  ticksProcessed: number;
  positionsOpened: number;
  positionsClosed: number;
  /** Total account equity at the end of the range — always fully flat (any still-open position is force-closed at range end). */
  finalEquity: Big;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ResolvedScenarioConfig {
  leverage: Big;
  symbols: string[];
  perpQtyStepBySymbol: Record<string, Big>;
  hourlyBorrowRate: Big;
  spotTakerFeeRate: Big;
  perpTakerFeeRate: Big;
  positionSizeUsd: Big | undefined;
}

export interface TickerSnapshot {
  lastPrice: Big;
  markPrice: Big | null;
  turnover24h: Big;
}

export interface PredictedFunding {
  rate: Big;
  intervalMinutes: number;
  nextFundingTimeMs: number;
}

export interface SettledFunding {
  rate: Big;
  intervalMinutes: number;
  fundingTimestampMs: number;
}

export interface LongShortRatioSnapshot {
  buyRatio: Big;
  sellRatio: Big;
}

export interface CandidateEvaluation {
  symbol: string;
  r8h: Big;
  perpMarkPrice: Big;
  spotPrice: Big;
  currentBasis: Big;
  perpQty: Big;
  spotQty: Big;
  entrySpotSlippageBp: Big;
  entryPerpSlippageBp: Big;
  tier: MarginTier;
  legNotional: Big;
  /** Context-only, for entry_reasoning — never gates the veto (see evaluateCandidate, now in ./candidateSelection.ts). Undefined if no OI collected yet at/before t. */
  openInterest: Big | undefined;
  /** Context-only, for entry_reasoning — never gates the veto. Undefined if no long/short-ratio row collected yet at/before t. */
  longShortRatio: LongShortRatioSnapshot | undefined;
}

export interface OpenPositionState {
  id: bigint;
  symbol: string;
  spotQty: Big;
  perpQty: Big;
  leverage: Big;
  spotEntryPrice: Big;
  perpEntryPrice: Big;
  entryBasis: Big;
  entryApr: Big;
  entryFees: Big;
  entrySpotSlippageBp: Big;
  entryPerpSlippageBp: Big;
  /** t.getTime() at open — fixed for the position's lifetime, unlike fundingAppliedThroughMs/lastBorrowAccrualMs below (both mutate as ticks pass). Used to compute hold duration for exit_reasoning. */
  openedAtMs: number;
  fundingAppliedThroughMs: number;
  fundingAccrued: Big;
  fundingPaymentsCollected: number;
  /** intervalMinutes of the most recently applied settled row — undefined until the first one is applied. Used only to size the gap-detection tolerance in applySettledFundingUpTo (now in ./tickProcessing.ts). */
  lastSettledIntervalMinutes: number | undefined;
  /** Set by applySettledFundingUpTo (now in ./tickProcessing.ts) if a gap consistent with collectSettledFunding.ts's documented silent-drop scenarios (limit:5 first-poll, >200-row outage catch-up — see that file's doc comment) is ever suspected between two settled rows applied to this position. Surfaced in exit_reasoning so a downstream report reader knows this position's funding P&L may be understated rather than trusting it silently. */
  fundingGapDetected: boolean;
  borrowCostAccrued: Big;
  lastBorrowAccrualMs: number;
  initialCapital: Big;
  liquidationInput: DeltaNeutralLiquidationInput;
  perpBankruptcyPrice: Big;
}
