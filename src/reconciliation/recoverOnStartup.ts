import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import type { PairIntentEvent } from "../execution/pairIntentState.js";

/**
 * ARCHITECTURE.md §4's `IDLE → RECOVERY` row, made concrete: "если бот
 * трейдил, есть открытые позиции, и бот отключится / сервер ляжет" — this
 * module is what runs on process startup, BEFORE any new trading decision is
 * made, to answer "was something in flight when we died, and if so what
 * actually happened on the exchange while we were gone."
 *
 * Deliberately split into two pieces, same pattern as predictive/vetoModel.ts's
 * NoOpVetoModel: a DB-reading function (real, runs today) and a PURE decision
 * function (real, fully tested today) that consumes an `ExchangeSnapshot` —
 * a typed interface for "what Bybit actually reports," injected rather than
 * fetched. No authenticated Bybit client exists yet in this codebase (no
 * order placement exists yet either — the user's own words: "щас нет скрипта
 * для работы с биржей торгами"), so this module cannot and does not attempt
 * the real API call. What it DOES do: make the recovery *decision logic*
 * complete, tested, and ready to be wired to a real client the moment one
 * exists, instead of that logic being designed under time pressure during an
 * actual incident.
 *
 * This module is NOT wired into collector.ts, killswitch-listener.ts, or any
 * live process. It has no caller today. It exists so the answer to "is a
 * recovery algorithm designed" is "yes, and here it is, tested" rather than
 * "we'll figure it out when it happens."
 */

/** One position's last-known intent, as read from the DB — the "what were we in the middle of" half of recovery. */
export interface UnresolvedIntent {
  positionId: bigint;
  symbol: string;
  /** 'open' | 'close' | 'unwind_leg' — see position_intents migration comment. */
  intentType: string;
  intendedQty: string | null; // numeric, ADR-003: string at the type level
}

/**
 * Finds, per symbol, the position that was left in a non-terminal state —
 * i.e. `closed_at IS NULL` — joined to its most recent intent row, which
 * records what the bot was last trying to do to it. Deliberately NOT also
 * filtered on `opened_at IS NOT NULL`: the migration comment on `positions`
 * says the row is created at the IDLE -> ENTRY_PENDING transition, before
 * `opened_at` is ever set — a crash mid `LEG1_SENT` (order sent, never
 * confirmed) leaves exactly this shape, and it is one of the scenarios
 * recovery most needs to catch, not one it can afford to skip.
 * `positions.state` is intentionally NOT filtered on either (schema.ts's own
 * comment: the state machine's string column isn't stabilized into a CHECK
 * constraint yet) — "closed_at IS NULL" is the one fact about a position
 * that recovery can trust regardless of which exact PairIntentState string
 * was last written.
 *
 * RR-22 (max one open paper position at a time) means this returns at most
 * one row today, but the query itself does not assume that invariant — a
 * future multi-position phase should not silently start ignoring rows here.
 */
export async function findUnresolvedIntents(db: Kysely<Database>): Promise<UnresolvedIntent[]> {
  const rows = await db
    .selectFrom("positions")
    .innerJoin("position_intents", "position_intents.position_id", "positions.id")
    .where("positions.closed_at", "is", null)
    .select([
      "positions.id as positionId",
      "positions.symbol as symbol",
      "position_intents.intent_type as intentType",
      "position_intents.intended_qty as intendedQty",
      "position_intents.created_at as intentCreatedAt",
    ])
    // Latest intent per position wins — DISTINCT ON requires an ORDER BY
    // starting with the same key, Kysely doesn't have a typed helper for
    // Postgres's DISTINCT ON, so this reads all intent rows for unresolved
    // positions and reduces to "latest per position" below in JS instead of
    // in SQL. RR-22 bounds this to a handful of rows in practice, so the
    // extra round-trip cost of not doing it in SQL is not worth the raw-SQL
    // escape hatch.
    .orderBy("position_intents.created_at", "asc")
    .execute();

  const latestByPosition = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    latestByPosition.set(row.positionId.toString(), row); // later rows (ORDER BY asc) overwrite earlier ones — last write wins
  }

  return [...latestByPosition.values()].map((row) => ({
    positionId: row.positionId,
    symbol: row.symbol,
    intentType: row.intentType,
    intendedQty: row.intendedQty,
  }));
}

/**
 * "What Bybit actually reports" for one symbol's pair — the ground truth
 * recovery reconciles the DB's last-known intent against. A real
 * implementation queries Bybit's position/order-status endpoints; that
 * client does not exist yet, so today this is only a type other code (tests,
 * and eventually a real client) can implement against.
 */
export interface ExchangeSnapshot {
  symbol: string;
  /** Net spot base-asset qty actually held, per Bybit. Zero (not null) if flat. */
  spotQty: string;
  /** Net perp position qty actually held, per Bybit. Zero (not null) if flat. Sign convention: same as positions.perp_qty. */
  perpQty: string;
  /** True if the exchange has no record of the order_link_id(s) this intent would have produced — i.e. it never reached the exchange at all. */
  noMatchingOrdersFound: boolean;
}

export type RecoveryOutcome = "CONFIRMED_FLAT" | "CONFIRMED_BOTH_LEGS" | "CONFIRMED_ONE_LEG";

export interface RecoveryDecision {
  outcome: RecoveryOutcome;
  /** Feeds directly into pairIntentState.ts's transition(current, event) — this module never calls transition() itself, so it stays decoupled from wherever recovery state actually lives. */
  event: PairIntentEvent;
  reasoning: string;
}

/**
 * ARCHITECTURE.md §4's three-outcome RECOVERY logic, transcribed from its
 * failure-scenario table:
 *
 * - Both legs present on the exchange (spot AND perp both non-zero, matching
 *   the intent's direction) → CONFIRMED_BOTH_LEGS → OPEN. The position
 *   genuinely survived the restart; treat it as still open.
 * - Neither leg present (both flat, or no matching orders ever found) →
 *   CONFIRMED_FLAT → IDLE. Nothing to recover; the intent never became a
 *   real position, or it was already fully closed before the restart.
 * - Exactly one leg present → CONFIRMED_ONE_LEG → STUCK_LEG. This is the
 *   dangerous case ARCHITECTURE.md's kill-switch-level-1 language exists
 *   for: a delta-neutral bot with only one leg open is carrying naked
 *   directional exposure. This function does NOT attempt to fix it — same
 *   authority boundary as transition(): STUCK_LEG has zero outgoing edges by
 *   design, manual intervention takes over from here.
 *
 * Pure function: no DB, no network, no clock. `zeroThreshold` exists only so
 * a caller with a symbol-specific qty step (RR-15-style residual dust) can
 * treat a near-zero balance as flat instead of requiring bit-for-bit "0" —
 * defaults to exact zero because dust-tolerance policy belongs to the
 * caller, not baked in here.
 */
export function decideRecoveryOutcome(snapshot: ExchangeSnapshot, zeroThreshold = 0): RecoveryDecision {
  const spotQty = Number(snapshot.spotQty);
  const perpQty = Number(snapshot.perpQty);
  const spotOpen = Math.abs(spotQty) > zeroThreshold;
  const perpOpen = Math.abs(perpQty) > zeroThreshold;

  if (spotOpen && perpOpen) {
    return {
      outcome: "CONFIRMED_BOTH_LEGS",
      event: "CONFIRMED_BOTH_LEGS",
      reasoning: `Both legs found on exchange for ${snapshot.symbol} (spot=${snapshot.spotQty}, perp=${snapshot.perpQty}) — position survived restart intact.`,
    };
  }

  if (!spotOpen && !perpOpen) {
    return {
      outcome: "CONFIRMED_FLAT",
      event: "CONFIRMED_FLAT",
      reasoning: snapshot.noMatchingOrdersFound
        ? `No matching orders found on exchange for ${snapshot.symbol} — intent never reached the exchange before the restart.`
        : `Both legs flat on exchange for ${snapshot.symbol} (spot=${snapshot.spotQty}, perp=${snapshot.perpQty}) — position was already fully closed before the restart.`,
    };
  }

  return {
    outcome: "CONFIRMED_ONE_LEG",
    event: "CONFIRMED_ONE_LEG",
    reasoning:
      `Only one leg found on exchange for ${snapshot.symbol} (spot=${snapshot.spotQty}, perp=${snapshot.perpQty}) — ` +
      `naked directional exposure, requires manual intervention (ARCHITECTURE.md §4 STUCK_LEG).`,
  };
}
