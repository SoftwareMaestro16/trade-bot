/**
 * Backlog #38 decision: a NEW, separate state machine for Phase 2 paper
 * trading — not a reuse of `execution/pairIntentState.ts` with failure
 * events simply never emitted. Reasoning, so a future Phase 3/4 reader does
 * not have to reconstruct it:
 *
 * Most of `pairIntentState.ts`'s 21 states/43 edges exist ONLY to represent
 * uncertainty that comes from an asynchronous network round trip to a real
 * exchange, or from this process crashing mid-request:
 * `LEG1_UNKNOWN`/`LEG2_UNKNOWN`/`UNWIND_UNKNOWN` (timeout, "did the order
 * actually go through?"), `LEG1_PARTIAL`/`LEG2_PARTIAL`/`CLOSE_PARTIAL`
 * (partial fills against real order-book liquidity this project does not
 * model in a historical-price replay), `DEGRADED` (local belief and an
 * INDEPENDENTLY-OBSERVED exchange truth disagree — in a synchronous replay
 * there is only one observer, the replay loop itself, so "the exchange says
 * something different from what we think" is not a rare case here, it is a
 * category error: there is no second observer to disagree with),
 * `FROZEN`/`RECOVERY` (WS/API health, process restart) and `STUCK_LEG`
 * (kill-switch escalation after repeated real-world failures). None of this
 * can occur in-process, single-threaded, over a fixed historical price
 * series with no network and no possibility of a crash the replay itself
 * doesn't control.
 *
 * Reusing the 21-state type here anyway (just never emitting those events)
 * was rejected: every `switch`/exhaustiveness check over `PairIntentState`
 * in Phase 2 code would still have to account for `DEGRADED`, `FROZEN`,
 * `RECOVERY`, `STUCK_LEG`, etc. — dead branches that exist only to satisfy
 * the compiler, which is itself a bug magnet (someone "fills in" a branch
 * that is provably unreachable) and is exactly the "code for a later phase"
 * bot-project-brief.md §10 says not to write yet ("Не пиши код «на
 * будущее». Только то, что нужно текущей фазе.").
 *
 * The cost the backlog calls out for choosing a separate machine — a
 * vocabulary drift between what Phase 2 logs and what Phase 3/4 will
 * actually run — is real, so it is addressed directly, edge by edge, in
 * the comments on `TRANSITIONS` below: every state/event name that means
 * the same thing in both machines is spelled IDENTICALLY to its
 * `pairIntentState.ts` counterpart (`IDLE`, `ENTRY_PENDING`, `OPEN`,
 * `EXIT_PENDING`, `CLOSED`, `INTENT_RECORDED`, `INTENT_CANCELLED`,
 * `STRATEGY_EXIT_APPROVED`, `RISK_FORCE_CLOSE`, `JOURNALED`,
 * `BOTH_LEGS_CLOSED`). Only two symbols are genuinely new
 * (`ENTRY_REJECTED`, `RISK_VETOED`, `BOTH_LEGS_OPENED`) and each is new
 * because the concept itself has no equivalent in the production machine —
 * see their individual comments below, not because a shorter name was
 * convenient.
 */

export type PaperPositionState =
  | "IDLE"
  | "ENTRY_PENDING"
  | "ENTRY_REJECTED"
  | "OPEN"
  | "EXIT_PENDING"
  | "CLOSED";

export type PaperPositionEvent =
  | "INTENT_RECORDED"
  | "RISK_VETOED"
  | "INTENT_CANCELLED"
  | "BOTH_LEGS_OPENED"
  | "STRATEGY_EXIT_APPROVED"
  | "RISK_FORCE_CLOSE"
  | "BOTH_LEGS_CLOSED"
  | "JOURNALED";

// Runtime mirror of PaperPositionState, same reason pairIntentState.ts keeps
// one: lets a test iterate "every state" and catch a state literal that
// compiles (it's in the union) but was typed on the wrong TRANSITIONS row.
export const ALL_STATES: readonly PaperPositionState[] = [
  "IDLE",
  "ENTRY_PENDING",
  "ENTRY_REJECTED",
  "OPEN",
  "EXIT_PENDING",
  "CLOSED",
];

export interface Transition {
  from: PaperPositionState;
  event: PaperPositionEvent;
  to: PaperPositionState;
}

// Every edge here is the happy-path subset of ARCHITECTURE.md §4's diagram,
// collapsed where the collapse itself is what "no network" means — see the
// module doc comment above for the overall argument, and the per-edge
// comment below for why THIS specific edge is named the way it is.
export const TRANSITIONS: readonly Transition[] = [
  // Identical to pairIntentState.ts's `IDLE + INTENT_RECORDED -> ENTRY_PENDING`
  // (ARCHITECTURE.md §4: "risk/ пропустил намерение, RR-12"). Same meaning:
  // risk/'s checkEntry veto chain passed for this tick's candidate.
  { from: "IDLE", event: "INTENT_RECORDED", to: "ENTRY_PENDING" },

  // NEW pair (state `ENTRY_REJECTED`, event `RISK_VETOED`) with no
  // pairIntentState.ts equivalent — and deliberately not spelled "REJECTED"
  // or reusing `LEG1_REJECTED`. In the production machine a risk veto is not
  // a state at all: it is the guard on the very same IDLE->ENTRY_PENDING
  // edge above failing, so nothing is ever recorded and the pair simply
  // never leaves IDLE. `LEG1_REJECTED`/the `REJECTED` event specifically
  // mean "an order already sent over the network was declined by the
  // exchange" (price band, insufficient margin, delisted instrument) — a
  // failure mode that cannot exist here because no order, virtual or real,
  // has been placed yet. This machine promotes the veto to an explicit,
  // observable state anyway (rather than matching production's "nothing
  // happens" behavior) because bot-project-brief.md §258's Phase 2 exit
  // criterion is "ни одного решения, которое я не могу объяснить по
  // логам" — a backtest that silently drops vetoed candidates cannot answer
  // "how many candidates did risk/ block, and why" from its own state log.
  { from: "IDLE", event: "RISK_VETOED", to: "ENTRY_REJECTED" },

  // Identical to pairIntentState.ts's `LEG1_REJECTED + INTENT_CANCELLED ->
  // IDLE`: a rejected attempt is closed out, the pair is flat again.
  { from: "ENTRY_REJECTED", event: "INTENT_CANCELLED", to: "IDLE" },

  // `BOTH_LEGS_OPENED` is new, coined as the entry-side mirror of
  // pairIntentState.ts's own `BOTH_LEGS_CLOSED` naming (see below) rather
  // than an unrelated invented term. It collapses
  // `ENTRY_PENDING->LEG1_SENT->LEG1_OPEN->LEG2_SENT->OPEN` (four edges, two
  // independent network round trips) into one, because that whole sequence
  // exists ONLY to represent "leg 1's outcome is known but leg 2's is still
  // in flight" — a real possibility over a network, impossible over a fixed
  // historical price series read synchronously in one process: both legs
  // fill at the same tick's price, or the tick is not a valid entry at all.
  { from: "ENTRY_PENDING", event: "BOTH_LEGS_OPENED", to: "OPEN" },

  // Identical to pairIntentState.ts's two OPEN->EXIT_PENDING edges. Both
  // reused verbatim, unmodified: strategy/'s exit decision and risk/'s
  // force-close trigger are outputs of this project's own pure functions,
  // not observations about exchange/network state, so they need no
  // adaptation to run inside a synchronous replay.
  { from: "OPEN", event: "STRATEGY_EXIT_APPROVED", to: "EXIT_PENDING" },
  { from: "OPEN", event: "RISK_FORCE_CLOSE", to: "EXIT_PENDING" },

  // Same collapse as BOTH_LEGS_OPENED, symmetric direction: production's
  // `EXIT_PENDING->LEG_CLOSE_SENT->CLOSE_PARTIAL/CLOSED` models one leg
  // closing before the other over the network. The event name itself,
  // `BOTH_LEGS_CLOSED`, is reused VERBATIM from pairIntentState.ts (that
  // machine's own `LEG_CLOSE_SENT + BOTH_LEGS_CLOSED -> CLOSED` edge) —
  // no new name needed here, the meaning is identical.
  { from: "EXIT_PENDING", event: "BOTH_LEGS_CLOSED", to: "CLOSED" },

  // Identical to pairIntentState.ts's `CLOSED + JOURNALED -> IDLE`.
  { from: "CLOSED", event: "JOURNALED", to: "IDLE" },
];

/**
 * Pure reducer, same contract as pairIntentState.ts's `transition()`: throws
 * on any (state, event) pair without a documented edge above, rather than
 * silently ignoring it or guessing. A scenarioRunner (future work, not this
 * file) that manages to construct an undocumented pair has a bug worth
 * surfacing immediately, not a case to paper over.
 */
export function transition(current: PaperPositionState, event: PaperPositionEvent): PaperPositionState {
  const match = TRANSITIONS.find((t) => t.from === current && t.event === event);
  if (!match) {
    throw new Error(
      `Invalid paper position transition: no edge for event "${event}" from state "${current}" ` +
        `(src/emulation/paperPositionState.ts). This event does not apply in this state — either ` +
        `the caller has a bug, or a real happy-path transition is missing from this table.`,
    );
  }
  return match.to;
}

/** Every event that has a defined transition from `state` — for logging/introspection, not decision-making. */
export function validEventsFrom(state: PaperPositionState): PaperPositionEvent[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.event);
}
