import Big from "big.js";

// This file is one of several sub-files split out of ../reportGenerator.ts —
// see that file's module doc comment for the full picture (sign convention,
// slippage/borrow-cost sourcing, the realized entry-margin check, start/end
// date semantics). This file holds the shared constants, row/type shapes,
// and small pure helpers used across the split-out sub-files.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateReportsResult {
  summaryMarkdown: string;
  tradesCsv: string;
  equityCurveCsv: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** risk/economics.ts's ENTRY_GROSS_MULTIPLIER (K=2.0, RR-24/FM-01) — see module doc comment. */
export const ENTRY_GROSS_MULTIPLIER = new Big("2.0");

/** Design spec: >= 80% of a scenario's closed trades must have passed the realized entry-margin check. */
export const MIN_ENTRY_MARGIN_PASS_RATE = new Big("0.80");

/** Design spec: reality-adjusted P&L band applied to NET p&l — brief's own "live will be 30-50% worse than paper" caveat. */
export const REALITY_ADJUST_LOW = new Big("0.5");
export const REALITY_ADJUST_HIGH = new Big("0.7");

export const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * risk/economics.ts's ENTRY_FLOOR_R8H (0.020%/8h — "never 0.010%",
 * PARAMS-CONSERVATIVE.md §5, checkEntryThreshold's floor gate) — not exported
 * from that module, so duplicated here on purpose, same convention as
 * ENTRY_GROSS_MULTIPLIER above. Used only for the narrative CSV column's "N×
 * above the entry floor" framing and the summary's r8h buckets below — never
 * re-derives or re-checks an actual entry decision.
 */
export const ENTRY_FLOOR_R8H = new Big("0.0002");

/** strategy/exitRules.ts / scenarioRunner.ts's closePosition reasonCode values, translated for the narrative column and the "Закономерности" section. An unrecognized code (future exitRules.ts addition) falls back to the raw code untranslated — see buildNarrative/exitReasonForTrade. */
// "по причине" governs the genitive case (like "из-за") — every phrase below
// must be genitive, not dative. FORCED_LIQUIDATION's "ликвидации" is correct
// either way (soft feminine -ия nouns share one form across genitive/dative/
// prepositional singular), which is what let the other five slip through.
export const EXIT_REASON_RU: Record<string, string> = {
  FUNDING_TURNED_NEGATIVE: "разворота funding rate в отрицательную зону",
  APR_HYSTERESIS_TRIGGERED: "падения текущего APR ниже порога гистерезиса от APR входа",
  BASIS_DIVERGED: "экстренного расхождения базиса сверх аварийного порога",
  DELISTED_OR_CONTRACT_CHANGED: "делистинга или смены параметров контракта",
  FORCED_LIQUIDATION: "принудительной ликвидации перп-ноги",
  SCENARIO_END: "окончания периода сценария (позиция оставалась открытой)",
};

/** Fixed r8h buckets for the "Закономерности" win-rate-by-entry-funding table — boundaries per owner's own spec, the lower one reusing ENTRY_FLOOR_R8H above. */
export const R8H_BUCKETS: { label: string; min: Big; max: Big | undefined }[] = [
  { label: "0.02–0.05%/8ч", min: ENTRY_FLOOR_R8H, max: new Big("0.0005") },
  { label: "0.05–0.15%/8ч", min: new Big("0.0005"), max: new Big("0.0015") },
  { label: "выше 0.15%/8ч", min: new Big("0.0015"), max: undefined },
];

/** A trade whose entry_reasoning has no parseable `r8h=` field (e.g. pre-this-feature data) — grouped separately rather than silently dropped or mis-bucketed. */
export const NO_R8H_DATA_BUCKET_LABEL = "нет данных о funding при входе";

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

export interface ScenarioRow {
  id: bigint;
  name: string;
  leverage: string;
  starting_deposit: string;
  status: string;
}

export interface TradeRow {
  scenarioId: bigint;
  scenarioName: string;
  tradeId: bigint;
  symbol: string;
  leverageTarget: Big;
  entryAt: Date;
  exitAt: Date;
  holdDurationHours: Big;
  fundingUsd: Big;
  basisPnlUsd: Big;
  feesUsd: Big; // <= 0
  slippageUsd: Big; // <= 0, from paper_positions.slippage_cost
  borrowCostUsd: Big; // <= 0, from paper_positions.borrow_cost
  netPnlUsd: Big;
  netPnlPctOfNotional: Big;
  result: "win" | "loss" | "breakeven";
  /** paper_positions.entry_reasoning, parsed as `key=value` pairs — see parseReasoningText. Empty object if null/unparseable (e.g. pre-this-feature fixture text). */
  entryContext: Record<string, string>;
  /** paper_positions.exit_reasoning, parsed the same way — `detail` (if present) is always the LAST key, its value the free-text remainder of the string. */
  exitContext: Record<string, string>;
}

export interface EquitySnapshotPoint {
  at: Date;
  totalEquity: Big;
}

export interface ScenarioActivity {
  positions: { opened_at: Date | null; closed_at: Date | null }[];
  fills: { fee: string; executed_at: Date }[];
  fundingPayments: { amount: string; paid_at: Date }[];
}

export interface ScenarioSummary {
  order: number;
  scenario: ScenarioRow;
  trades: TradeRow[];
  snapshots: EquitySnapshotPoint[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function groupBy<T>(items: T[], keyOf: (t: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return map;
}

export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function bigSum(values: Big[]): Big {
  return values.reduce((acc, v) => acc.plus(v), new Big(0));
}

/**
 * Parses scenarioRunner.ts's `entry_reasoning`/`exit_reasoning` free-text
 * format (`key1=value1 key2=value2 ... detail=free text sentence`, see that
 * file's openNewPosition/closePosition) into a plain lookup. Every key except
 * `detail` has a single non-space token as its value (a Big decimal string,
 * "n/a", or a bare code) so a greedy `key=token` scan is enough; `detail`,
 * when present, is always the LAST key and its value runs to the end of the
 * string (a full human sentence, which may itself contain spaces) — handled
 * as a special case rather than by the same per-token regex.
 *
 * Returns `{}` for null/empty text, or for text with no `key=value` pairs at
 * all (e.g. older fixtures/rows that predate this format) — callers must
 * treat every field as optional, never assume a key is present.
 */
export function parseReasoningText(text: string | null): Record<string, string> {
  if (!text) return {};
  const detailMarker = "detail=";
  const detailIdx = text.indexOf(detailMarker);
  const head = detailIdx === -1 ? text : text.slice(0, detailIdx);
  const fields: Record<string, string> = {};
  for (const match of head.matchAll(/(\S+?)=(\S*)/g)) {
    fields[match[1]!] = match[2]!;
  }
  if (detailIdx !== -1) {
    fields.detail = text.slice(detailIdx + detailMarker.length);
  }
  return fields;
}

/**
 * Reads a parsed entry_reasoning/exit_reasoning field as a Big, or undefined
 * if absent/"n/a"/unparseable. Shared by buildNarrative (per-trade CSV
 * column) and the "Закономерности" aggregation below — never throws, since
 * both callers treat a missing/malformed field as "no data", not an error.
 * (buildNarrative now lives in ./narrative.ts, the aggregation in ./summary.ts.)
 */
export function parseContextBig(context: Record<string, string>, key: string): Big | undefined {
  const raw = context[key];
  if (raw === undefined || raw === "n/a") return undefined;
  try {
    return new Big(raw);
  } catch {
    return undefined;
  }
}
