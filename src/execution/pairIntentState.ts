/**
 * The position state machine from ARCHITECTURE.md §4 — Phase 0's exit
 * criterion, transcribed exactly (not reconstructed from memory) from that
 * document's mermaid diagram and its transition table. This module is PURE:
 * given a current state and an event, it returns the next state or throws.
 * It does not call the exchange, does not touch the database, does not know
 * what an `orderLinkId` looks like. Wiring this to real order placement is a
 * separate, later piece — this file's only job is to make it structurally
 * impossible for the rest of the system to reach a state transition that
 * ARCHITECTURE.md doesn't document.
 *
 * A delta-neutral pair is always described by ONE state, never two
 * independent per-leg states — ARCHITECTURE.md §4's own reasoning: two
 * independent state trackers is exactly how "what the bot thinks about leg A"
 * and "what it thinks about leg B" drift apart.
 */

export type PairIntentState =
  | "IDLE"
  | "ENTRY_PENDING"
  | "LEG1_SENT"
  | "LEG1_UNKNOWN"
  | "LEG1_OPEN"
  | "LEG1_REJECTED"
  | "LEG1_PARTIAL"
  | "LEG2_SENT"
  | "LEG2_UNKNOWN"
  | "LEG2_PARTIAL"
  | "OPEN"
  | "UNWINDING_LEG1"
  | "UNWIND_UNKNOWN"
  | "STUCK_LEG"
  | "DEGRADED"
  | "FROZEN"
  | "EXIT_PENDING"
  | "LEG_CLOSE_SENT"
  | "CLOSE_PARTIAL"
  | "CLOSED"
  | "RECOVERY";

export type PairIntentEvent =
  | "INTENT_RECORDED"
  | "LEG1_ORDER_SENT"
  | "TIMEOUT"
  | "RESOLVED_FILLED"
  | "RESOLVED_NOT_FOUND"
  | "REJECTED"
  | "INTENT_CANCELLED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "TOPPED_UP_OR_ACCEPTED"
  | "LEG2_ORDER_SENT"
  | "TOP_UP_TIMEOUT"
  | "TOPPED_UP_FULLY"
  | "RESOLVED_CLOSED"
  | "RESOLVED_NOT_CLOSED"
  | "CLOSED_ENTRY_FAILED"
  | "RETRIES_EXHAUSTED"
  | "RECONCILED_OK"
  | "RECONCILIATION_MISMATCH"
  | "MISMATCH_EXPLAINED"
  | "MISMATCH_UNEXPLAINED"
  | "STRATEGY_EXIT_APPROVED"
  | "RISK_FORCE_CLOSE"
  | "CLOSE_ORDERS_SENT"
  | "ONE_LEG_CLOSED"
  | "RETRY_REMAINING_LEG"
  | "BOTH_LEGS_CLOSED"
  | "JOURNALED"
  | "FREEZE_TRIGGER"
  | "RESUME_CONFIRMED"
  | "FREEZE_ESCALATED"
  | "STARTUP_FOUND_UNRESOLVED"
  | "CONFIRMED_FLAT"
  | "CONFIRMED_BOTH_LEGS"
  | "CONFIRMED_ONE_LEG";

// Runtime mirror of the PairIntentState union — TS types don't exist at
// runtime, so this is what lets a test iterate "every state" and catch a
// typo'd state literal in TRANSITIONS that the union type alone wouldn't
// (a string literal outside the union is a compile error; a string literal
// that IS in the union but on the wrong row is not, and only a runtime
// cross-check against this list catches that).
export const ALL_STATES: readonly PairIntentState[] = [
  "IDLE",
  "ENTRY_PENDING",
  "LEG1_SENT",
  "LEG1_UNKNOWN",
  "LEG1_OPEN",
  "LEG1_REJECTED",
  "LEG1_PARTIAL",
  "LEG2_SENT",
  "LEG2_UNKNOWN",
  "LEG2_PARTIAL",
  "OPEN",
  "UNWINDING_LEG1",
  "UNWIND_UNKNOWN",
  "STUCK_LEG",
  "DEGRADED",
  "FROZEN",
  "EXIT_PENDING",
  "LEG_CLOSE_SENT",
  "CLOSE_PARTIAL",
  "CLOSED",
  "RECOVERY",
];

export interface Transition {
  from: PairIntentState;
  event: PairIntentEvent;
  to: PairIntentState;
}

// Transcribed 1:1 from ARCHITECTURE.md §4's mermaid diagram — 43 edges, one
// row per arrow in that diagram, in the same order it lists them. Do not add
// or remove an edge here without updating that diagram first: it is the
// source of truth, this is its implementation, not the other way around.
// Exported (read-only) specifically so tests can verify structural properties
// of the graph itself (reachability, no orphan states, no duplicate edges)
// against this single source of data, instead of hand-copying a second list
// that could silently drift from this one.
export const TRANSITIONS: readonly Transition[] = [
  { from: "IDLE", event: "INTENT_RECORDED", to: "ENTRY_PENDING" },
  { from: "ENTRY_PENDING", event: "LEG1_ORDER_SENT", to: "LEG1_SENT" },
  { from: "LEG1_SENT", event: "TIMEOUT", to: "LEG1_UNKNOWN" },
  { from: "LEG1_UNKNOWN", event: "RESOLVED_FILLED", to: "LEG1_OPEN" },
  { from: "LEG1_UNKNOWN", event: "RESOLVED_NOT_FOUND", to: "ENTRY_PENDING" },
  { from: "LEG1_SENT", event: "REJECTED", to: "LEG1_REJECTED" },
  { from: "LEG1_REJECTED", event: "INTENT_CANCELLED", to: "IDLE" },
  { from: "LEG1_SENT", event: "FILLED", to: "LEG1_OPEN" },
  { from: "LEG1_SENT", event: "PARTIALLY_FILLED", to: "LEG1_PARTIAL" },
  { from: "LEG1_PARTIAL", event: "TOPPED_UP_OR_ACCEPTED", to: "LEG1_OPEN" },
  { from: "LEG1_OPEN", event: "LEG2_ORDER_SENT", to: "LEG2_SENT" },
  { from: "LEG2_SENT", event: "TIMEOUT", to: "LEG2_UNKNOWN" },
  { from: "LEG2_UNKNOWN", event: "RESOLVED_FILLED", to: "OPEN" },
  { from: "LEG2_UNKNOWN", event: "RESOLVED_NOT_FOUND", to: "UNWINDING_LEG1" },
  { from: "LEG2_SENT", event: "REJECTED", to: "UNWINDING_LEG1" },
  { from: "LEG2_SENT", event: "PARTIALLY_FILLED", to: "LEG2_PARTIAL" },
  { from: "LEG2_PARTIAL", event: "TOP_UP_TIMEOUT", to: "UNWINDING_LEG1" },
  { from: "LEG2_PARTIAL", event: "TOPPED_UP_FULLY", to: "OPEN" },
  { from: "LEG2_SENT", event: "FILLED", to: "OPEN" },
  { from: "UNWINDING_LEG1", event: "TIMEOUT", to: "UNWIND_UNKNOWN" },
  { from: "UNWIND_UNKNOWN", event: "RESOLVED_CLOSED", to: "IDLE" },
  { from: "UNWIND_UNKNOWN", event: "RESOLVED_NOT_CLOSED", to: "UNWINDING_LEG1" },
  { from: "UNWINDING_LEG1", event: "CLOSED_ENTRY_FAILED", to: "IDLE" },
  { from: "UNWINDING_LEG1", event: "RETRIES_EXHAUSTED", to: "STUCK_LEG" },
  { from: "OPEN", event: "RECONCILED_OK", to: "OPEN" },
  { from: "OPEN", event: "RECONCILIATION_MISMATCH", to: "DEGRADED" },
  { from: "DEGRADED", event: "MISMATCH_EXPLAINED", to: "OPEN" },
  { from: "DEGRADED", event: "MISMATCH_UNEXPLAINED", to: "STUCK_LEG" },
  { from: "OPEN", event: "STRATEGY_EXIT_APPROVED", to: "EXIT_PENDING" },
  { from: "OPEN", event: "RISK_FORCE_CLOSE", to: "EXIT_PENDING" },
  { from: "EXIT_PENDING", event: "CLOSE_ORDERS_SENT", to: "LEG_CLOSE_SENT" },
  { from: "LEG_CLOSE_SENT", event: "ONE_LEG_CLOSED", to: "CLOSE_PARTIAL" },
  { from: "CLOSE_PARTIAL", event: "RETRY_REMAINING_LEG", to: "LEG_CLOSE_SENT" },
  { from: "CLOSE_PARTIAL", event: "RETRIES_EXHAUSTED", to: "STUCK_LEG" },
  { from: "LEG_CLOSE_SENT", event: "BOTH_LEGS_CLOSED", to: "CLOSED" },
  { from: "CLOSED", event: "JOURNALED", to: "IDLE" },
  { from: "OPEN", event: "FREEZE_TRIGGER", to: "FROZEN" },
  { from: "FROZEN", event: "RESUME_CONFIRMED", to: "OPEN" },
  { from: "FROZEN", event: "FREEZE_ESCALATED", to: "EXIT_PENDING" },
  { from: "IDLE", event: "STARTUP_FOUND_UNRESOLVED", to: "RECOVERY" },
  { from: "RECOVERY", event: "CONFIRMED_FLAT", to: "IDLE" },
  { from: "RECOVERY", event: "CONFIRMED_BOTH_LEGS", to: "OPEN" },
  { from: "RECOVERY", event: "CONFIRMED_ONE_LEG", to: "STUCK_LEG" },
];

/**
 * `STUCK_LEG` has zero outgoing edges by design — ARCHITECTURE.md's diagram
 * ends it at `[*]`, meaning this module's authority stops there: kill switch
 * level 1 and manual intervention take over. A caller trying to transition
 * out of `STUCK_LEG` through this function is a bug, not a recoverable case,
 * and `transition()` below will throw for it like any other undocumented edge.
 */
export function transition(current: PairIntentState, event: PairIntentEvent): PairIntentState {
  const match = TRANSITIONS.find((t) => t.from === current && t.event === event);
  if (!match) {
    throw new Error(
      `Invalid state transition: no edge for event "${event}" from state "${current}" ` +
        `(ARCHITECTURE.md §4). This event does not apply in this state — either the caller ` +
        `has a bug, or a real transition is missing from the diagram; it must never be both ` +
        `silently ignored and never resolved.`,
    );
  }
  return match.to;
}

/** Every event that has a defined transition from `state` — for logging/introspection, not decision-making. */
export function validEventsFrom(state: PairIntentState): PairIntentEvent[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.event);
}

export function isStuck(state: PairIntentState): state is "STUCK_LEG" {
  return state === "STUCK_LEG";
}
