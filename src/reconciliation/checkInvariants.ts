import Big from "big.js";
import type { Kysely } from "kysely";
import { checkAccountMMRate, checkLeverage } from "../risk/leverage.js";
import type { Database } from "../storage/schema.js";

/**
 * ARCHITECTURE.md §4's "Инварианты, которые reconciliation/ проверяет каждый
 * цикл" — five numbered checks, transcribed here as pure functions. Same split
 * as recoverOnStartup.ts: a DB-reading half (findOpenPositions,
 * findPendingOrders — real queries, run today) and a pure decision half (the
 * five check* functions plus evaluateReconciliationCycle — no DB, no
 * exchange, no clock except what's passed in). "What Bybit actually holds
 * right now" is, same as recoverOnStartup.ts's ExchangeSnapshot, an injected
 * parameter rather than a live call: no authenticated Bybit client exists yet
 * (ADR-002/NFR-11 confines `bybit-api` imports to exchange/, and
 * exchange/client.ts's own doc comment is explicit that authenticated calls
 * are deliberately deferred to a later phase, per SRS's "не пиши код на
 * будущее"). This module does not violate that boundary: it never imports
 * `bybit-api`, only typed data shapes describing what such a call would
 * eventually return.
 *
 * Invariant 5 (leverage/margin ceiling) deliberately does NOT reimplement its
 * own threshold — it calls risk/leverage.ts's checkLeverage and
 * checkAccountMMRate directly. Those already own the RR-20/FM-25 numbers;
 * duplicating them here would let a future PARAMS-CONSERVATIVE.md change
 * update the entry-time veto without updating the exact same ceiling this
 * module polls post-entry, silently reintroducing the two-source-of-truth
 * bug ADR-006 already reasons about for the leverage formula itself.
 *
 * Nothing in this module is called by trader or killswitch-listener yet —
 * same "designed and tested ahead of the live wiring it will eventually
 * need" status as recoverOnStartup.ts, not a live reconciliation loop.
 */

export interface InvariantViolation {
  invariant: 1 | 2 | 3 | 4 | 5;
  /** null for invariant 1, which is a portfolio-wide count, not a per-symbol fact. */
  symbol: string | null;
  code: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Invariant 1: local open-position count must equal the exchange's count of
// symbols with a nonzero perp position.
// ---------------------------------------------------------------------------

export interface LocalOpenSymbol {
  symbol: string;
}

export interface ExchangePerpHolding {
  symbol: string;
  perpQty: Big;
}

export function checkPositionCountMatch(
  local: readonly LocalOpenSymbol[],
  exchange: readonly ExchangePerpHolding[],
): InvariantViolation[] {
  // ARCHITECTURE.md's wording is asymmetric on purpose: "число ОТКРЫТЫХ
  // ПОЗИЦИЙ" on the local side vs. "число СИМВОЛОВ" on the exchange side —
  // so the local count is `local.length` (position rows), NOT
  // `localSymbols.size` (distinct symbols). RR-22 means these coincide today
  // (at most one open position per symbol), but counting via a Set would
  // silently collapse two OPEN rows for the same symbol into one, masking
  // exactly the kind of duplicate this invariant exists to catch — counting
  // rows, not deduplicating them, is the only version of this check that
  // still works if that invariant is ever violated upstream.
  const localSymbols = new Set(local.map((l) => l.symbol));
  const exchangeOpenSymbols = new Set(exchange.filter((e) => !e.perpQty.eq(0)).map((e) => e.symbol));

  if (local.length === exchangeOpenSymbols.size) return [];

  const onlyLocal = [...localSymbols].filter((s) => !exchangeOpenSymbols.has(s));
  const onlyExchange = [...exchangeOpenSymbols].filter((s) => !localSymbols.has(s));
  return [
    {
      invariant: 1,
      symbol: null,
      code: "POSITION_COUNT_MISMATCH",
      reason:
        `Local open positions: ${local.length}, exchange nonzero perp positions: ${exchangeOpenSymbols.size}.` +
        (onlyLocal.length > 0 ? ` Only in local state: ${onlyLocal.join(", ")}.` : "") +
        (onlyExchange.length > 0 ? ` Only on exchange: ${onlyExchange.join(", ")}.` : ""),
    },
  ];
}

// ---------------------------------------------------------------------------
// Invariant 2: residual delta between spot and perp legs, RR-15. Same
// fraction-of-notional model as strategy/sizing.ts's FM-12 guard (RISK-
// REGISTER.md's own formula is stated in those terms), applied post-hoc to
// actually-held quantities instead of pre-trade to the intended ones.
//
// spotQty and perpQtyEquivalent are both expected to be NON-NEGATIVE
// magnitudes, matching how strategy/sizing.ts and storage/schema.ts's
// positions.spot_qty/perp_qty actually store them (direction lives in which
// side traded, e.g. the perp order's `side`, never in the stored quantity's
// sign — sizing.ts's own SizingOutcome literally sets `spotQty: perpQty`,
// the same positive value). This function does not reject a negative input
// itself, but no real caller (findOpenPositions's rows included) will ever
// produce one — a negative value here would mean a sign bug further upstream
// worth investigating on its own terms, not a case this function's contract
// is written to make sense of.
// ---------------------------------------------------------------------------

/** Matches strategy/sizing.ts's DEFAULT_MAX_RESIDUAL_DELTA (FM-12) — same tolerance concept, not independently tuned. */
export const DEFAULT_MAX_RESIDUAL_DELTA = new Big("0.005");

export function checkResidualDelta(
  symbol: string,
  spotQty: Big,
  perpQtyEquivalent: Big,
  markPrice: Big,
  maxResidualDeltaFraction: Big = DEFAULT_MAX_RESIDUAL_DELTA,
): InvariantViolation[] {
  const positionNotional = perpQtyEquivalent.abs().times(markPrice);

  // A position this function is even asked to check is, by definition, one
  // reconciliation believes is OPEN — a zero perp-side notional here means
  // the perp leg has already vanished, which invariant 3 (ADL/shrinkage) or
  // invariant 1 (count mismatch) exists to name specifically. Reported here
  // too, rather than silently dividing by zero, so a caller that runs this
  // check in isolation (e.g. a unit test) still fails closed instead of
  // throwing — same "cannot evaluate, so deny/report" treatment as
  // strategy/sizing.ts's own guards on markPrice/perpQtyStep.
  if (positionNotional.lte(0)) {
    return [
      {
        invariant: 2,
        symbol,
        code: "RESIDUAL_DELTA_UNDEFINED",
        reason: `Cannot compute residual delta for ${symbol}: perp-side notional is ${positionNotional.toString()} (perpQtyEquivalent=${perpQtyEquivalent.toString()}, markPrice=${markPrice.toString()}) — the perp leg has no measurable size.`,
      },
    ];
  }

  const deltaQty = spotQty.minus(perpQtyEquivalent).abs();
  const residualDeltaFraction = deltaQty.times(markPrice).div(positionNotional);

  if (residualDeltaFraction.gt(maxResidualDeltaFraction)) {
    return [
      {
        invariant: 2,
        symbol,
        code: "RESIDUAL_DELTA_EXCEEDED",
        reason: `${symbol}: residual delta ${residualDeltaFraction.toString()} (spotQty=${spotQty.toString()}, perpQty=${perpQtyEquivalent.toString()}) exceeds ${maxResidualDeltaFraction.toString()} (RR-15).`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Invariant 3: ADL detection, FR-305 — the perp leg must not shrink without a
// matching fill event explaining the shrinkage.
// ---------------------------------------------------------------------------

export function checkNoUnexplainedShrinkage(
  symbol: string,
  perpQtyBefore: Big,
  perpQtyNow: Big,
  explainedByFillsQty: Big,
  /** Dust tolerance for float/step noise — defaults to zero (any unexplained shrinkage at all is reported); callers with a symbol-specific qtyStep may widen it. */
  toleranceQty: Big = new Big(0),
): InvariantViolation[] {
  const shrinkage = perpQtyBefore.abs().minus(perpQtyNow.abs());
  if (shrinkage.lte(0)) return []; // grew or stayed the same — ADL only ever shrinks a position, never grows one

  const unexplained = shrinkage.minus(explainedByFillsQty);
  if (unexplained.gt(toleranceQty)) {
    return [
      {
        invariant: 3,
        symbol,
        code: "UNEXPLAINED_PERP_SHRINKAGE",
        reason:
          `${symbol}: perp qty shrank from ${perpQtyBefore.toString()} to ${perpQtyNow.toString()} ` +
          `(${shrinkage.toString()} lost), only ${explainedByFillsQty.toString()} explained by recorded fills — ` +
          `${unexplained.toString()} unexplained. Possible ADL (FR-305, RR-10 violated).`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Invariant 4: no position stuck in an intermediate order state (*_SENT /
// *_UNKNOWN, i.e. an order whose own status is still 'sent' or 'unknown')
// longer than a timeout. This is a defensive backstop — the normal per-leg
// TIMEOUT transition (pairIntentState.ts) is expected to have already fired
// by this point; finding one here means that didn't happen for some reason,
// so it does NOT map to a state-machine event of its own (nothing in
// TRANSITIONS represents "reconciliation noticed a stuck order") — it is a
// forced-recheck trigger, surfaced separately by evaluateReconciliationCycle
// below rather than folded into RECONCILED_OK/RECONCILIATION_MISMATCH.
// ---------------------------------------------------------------------------

/** orders.status values that mean "sent, not yet resolved" — see ARCHITECTURE.md §4 / the orders table's own migration comment for the full status set. */
export const INTERMEDIATE_ORDER_STATUSES: ReadonlySet<string> = new Set(["sent", "unknown"]);

export interface PendingOrderStatus {
  symbol: string;
  leg: "spot" | "perp";
  orderLinkId: string;
  status: string;
  sentAt: Date | null;
}

export function checkNoStuckOrders(
  orders: readonly PendingOrderStatus[],
  now: Date,
  timeoutMs: number,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const order of orders) {
    if (!INTERMEDIATE_ORDER_STATUSES.has(order.status)) continue;
    if (!order.sentAt) continue; // recorded but never actually sent — nothing in flight to time out

    const ageMs = now.getTime() - order.sentAt.getTime();
    if (ageMs > timeoutMs) {
      violations.push({
        invariant: 4,
        symbol: order.symbol,
        code: "STUCK_INTERMEDIATE_ORDER",
        reason:
          `${order.symbol}: order ${order.orderLinkId} (${order.leg}) has been "${order.status}" for ${ageMs}ms, ` +
          `exceeding the ${timeoutMs}ms timeout — forced orderLinkId re-check required, even though the normal ` +
          `per-leg TIMEOUT transition should already have caught this.`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 5: leverage/margin ceiling, RR-20/FM-25 — delegates entirely to
// risk/leverage.ts, see this module's own doc comment for why.
//
// Unlike every other check in this file, checkLivePositionLeverage THROWS
// (a RangeError, not a returned violation) when totalEquity<=0 — inherited
// verbatim from checkLeverage's own contract ("the account is dead, not
// merely risky, at zero-or-negative equity... the caller must guarantee
// positive equity"). This is not an oversight: re-deriving totalEquity is
// this module's caller's job, same as it is for every other checkLeverage
// caller, and turning that throw into a swallowed violation here would mean
// silently disagreeing with risk/'s own definition of "cannot happen under
// correct business logic" for the one caller that reuses it.
// ---------------------------------------------------------------------------

export function checkLivePositionLeverage(shortNotional: Big, totalEquity: Big): InvariantViolation[] {
  const result = checkLeverage(shortNotional, totalEquity);
  if (result.allowed) return [];
  return [{ invariant: 5, symbol: null, code: result.code, reason: result.reason }];
}

export function checkLiveAccountMMRate(projectedAccountMMRate: Big): InvariantViolation[] {
  const result = checkAccountMMRate(projectedAccountMMRate);
  if (result.allowed) return [];
  return [{ invariant: 5, symbol: null, code: result.code, reason: result.reason }];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type ReconciliationCycleEvent = "RECONCILED_OK" | "RECONCILIATION_MISMATCH" | "FREEZE_TRIGGER";

export interface ReconciliationCycleResult {
  event: ReconciliationCycleEvent;
  /** The violations that produced `event` — empty when event is RECONCILED_OK. */
  violations: InvariantViolation[];
  /** Invariant-4 findings are ALWAYS surfaced here regardless of `event`, since they trigger a forced recheck rather than a state transition — see this module's doc comment above checkNoStuckOrders. */
  staleOrderWarnings: InvariantViolation[];
}

/**
 * Reduces a cycle's collected violations to the one event pairIntentState.ts's
 * OPEN state can actually receive. OPEN has two distinct outgoing edges for a
 * bad cycle — RECONCILIATION_MISMATCH -> DEGRADED and FREEZE_TRIGGER ->
 * FROZEN — so at most one fires per cycle even if multiple invariants failed
 * at once. Leverage/margin violations (invariant 5) take priority: they are
 * ARCHITECTURE.md's own "risk/ триггер level-2" category (alongside API-error
 * streaks and WS loss), a more urgent class of problem than a position-shape
 * mismatch — this priority ordering is this function's own judgment call,
 * since ARCHITECTURE.md's table does not state one explicitly for the
 * simultaneous case.
 */
export function evaluateReconciliationCycle(violations: readonly InvariantViolation[]): ReconciliationCycleResult {
  const staleOrderWarnings = violations.filter((v) => v.invariant === 4);
  const leverageViolations = violations.filter((v) => v.invariant === 5);
  const mismatchViolations = violations.filter((v) => v.invariant === 1 || v.invariant === 2 || v.invariant === 3);

  if (leverageViolations.length > 0) {
    return { event: "FREEZE_TRIGGER", violations: leverageViolations, staleOrderWarnings };
  }
  if (mismatchViolations.length > 0) {
    return { event: "RECONCILIATION_MISMATCH", violations: mismatchViolations, staleOrderWarnings };
  }
  return { event: "RECONCILED_OK", violations: [], staleOrderWarnings };
}

// ---------------------------------------------------------------------------
// DB-reading half — real queries (not stubs), same pattern as
// recoverOnStartup.ts's findUnresolvedIntents.
// ---------------------------------------------------------------------------

export interface LocalOpenPositionRow {
  symbol: string;
  spotQty: string | null;
  perpQty: string | null;
}

/** Every position currently in the OPEN state — the set invariants 2 and 3 need to check. */
export async function findOpenPositions(db: Kysely<Database>): Promise<LocalOpenPositionRow[]> {
  return db
    .selectFrom("positions")
    .where("state", "=", "OPEN")
    .select(["symbol", "spot_qty as spotQty", "perp_qty as perpQty"])
    .execute();
}

/** Every order still in an intermediate status ('sent' | 'unknown') — the set invariant 4 needs to check, filtered in SQL rather than fetched in full since `orders` is append-only and grows without bound. */
export async function findPendingOrders(db: Kysely<Database>): Promise<PendingOrderStatus[]> {
  const rows = await db
    .selectFrom("orders")
    .innerJoin("positions", "positions.id", "orders.position_id")
    .where("orders.status", "in", [...INTERMEDIATE_ORDER_STATUSES])
    .select([
      "positions.symbol as symbol",
      "orders.leg as leg",
      "orders.order_link_id as orderLinkId",
      "orders.status as status",
      "orders.sent_at as sentAt",
    ])
    .execute();
  return rows;
}
