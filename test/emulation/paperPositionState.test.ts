import { describe, expect, it } from "vitest";
import {
  ALL_STATES,
  TRANSITIONS,
  transition,
  validEventsFrom,
} from "../../src/emulation/paperPositionState.js";
import type { PaperPositionState } from "../../src/emulation/paperPositionState.js";

describe("transition — every documented happy-path edge", () => {
  it.each(TRANSITIONS.map((t) => [t.from, t.event, t.to] as const))(
    "%s + %s -> %s",
    (from, event, to) => {
      expect(transition(from, event)).toBe(to);
    },
  );
});

describe("transition — the specific split backlog #38 exists to resolve", () => {
  it("IDLE splits on risk/'s decision: INTENT_RECORDED enters, RISK_VETOED rejects, neither throws", () => {
    expect(transition("IDLE", "INTENT_RECORDED")).toBe("ENTRY_PENDING");
    expect(transition("IDLE", "RISK_VETOED")).toBe("ENTRY_REJECTED");
  });

  it("ENTRY_REJECTED is not a dead end — INTENT_CANCELLED returns the pair to IDLE, same as pairIntentState.ts's LEG1_REJECTED", () => {
    expect(transition("ENTRY_REJECTED", "INTENT_CANCELLED")).toBe("IDLE");
  });

  it("both legs open/close atomically in one edge — no LEG1/LEG2 intermediate states exist in this machine", () => {
    expect(transition("ENTRY_PENDING", "BOTH_LEGS_OPENED")).toBe("OPEN");
    expect(transition("EXIT_PENDING", "BOTH_LEGS_CLOSED")).toBe("CLOSED");
  });

  it("both OPEN exit triggers (strategy-decided and risk-forced) land on the same EXIT_PENDING state, matching pairIntentState.ts", () => {
    expect(transition("OPEN", "STRATEGY_EXIT_APPROVED")).toBe("EXIT_PENDING");
    expect(transition("OPEN", "RISK_FORCE_CLOSE")).toBe("EXIT_PENDING");
  });

  it("a full round trip returns to IDLE: IDLE -> ENTRY_PENDING -> OPEN -> EXIT_PENDING -> CLOSED -> IDLE", () => {
    let state: PaperPositionState = "IDLE";
    state = transition(state, "INTENT_RECORDED");
    state = transition(state, "BOTH_LEGS_OPENED");
    state = transition(state, "STRATEGY_EXIT_APPROVED");
    state = transition(state, "BOTH_LEGS_CLOSED");
    state = transition(state, "JOURNALED");
    expect(state).toBe("IDLE");
  });
});

describe("transition — rejects undocumented transitions instead of guessing", () => {
  it("throws for an event that doesn't apply in the given state", () => {
    expect(() => transition("IDLE", "BOTH_LEGS_OPENED")).toThrow(/Invalid paper position transition/);
  });

  it("throws for network/failure-shaped events that have no place in this machine at all", () => {
    // These are not part of PaperPositionEvent's type, so callers get a
    // compile error before ever reaching transition() — this test documents
    // that intent for a reader comparing the two machines, using an `as`
    // cast to still exercise the runtime guard directly.
    expect(() =>
      transition("ENTRY_PENDING", "TIMEOUT" as unknown as "BOTH_LEGS_OPENED"),
    ).toThrow(/Invalid paper position transition/);
  });

  it("error message names both the offending state and event", () => {
    expect(() => transition("CLOSED", "RISK_VETOED")).toThrow(/"RISK_VETOED".*"CLOSED"/s);
  });
});

describe("graph well-formedness", () => {
  it("every transition references states that exist in ALL_STATES", () => {
    for (const t of TRANSITIONS) {
      expect(ALL_STATES).toContain(t.from);
      expect(ALL_STATES).toContain(t.to);
    }
  });

  it("every state has at least one outgoing transition — nothing is an unintended dead end", () => {
    for (const state of ALL_STATES) {
      const outgoing = TRANSITIONS.filter((t) => t.from === state);
      expect(outgoing.length).toBeGreaterThan(0);
    }
  });

  it("every state has at least one incoming transition — nothing is unreachable", () => {
    for (const state of ALL_STATES) {
      const incoming = TRANSITIONS.filter((t) => t.to === state);
      expect(incoming.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate (from, event) pairs — the machine is deterministic, never ambiguous", () => {
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      const key = `${t.from}::${t.event}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("every state is reachable from IDLE by following documented transitions (breadth-first)", () => {
    const reachable = new Set<PaperPositionState>(["IDLE"]);
    let frontier: PaperPositionState[] = ["IDLE"];
    while (frontier.length > 0) {
      const next: PaperPositionState[] = [];
      for (const state of frontier) {
        for (const t of TRANSITIONS.filter((tr) => tr.from === state)) {
          if (!reachable.has(t.to)) {
            reachable.add(t.to);
            next.push(t.to);
          }
        }
      }
      frontier = next;
    }
    for (const state of ALL_STATES) {
      expect(reachable.has(state)).toBe(true);
    }
  });

  it("has exactly 6 states and 8 edges — the deliberately small happy-path subset, not a copy of the 21/43 production machine", () => {
    expect(ALL_STATES).toHaveLength(6);
    expect(TRANSITIONS).toHaveLength(8);
  });
});

describe("validEventsFrom", () => {
  it("lists exactly the events with a defined edge from a given state", () => {
    expect(validEventsFrom("ENTRY_REJECTED")).toEqual(["INTENT_CANCELLED"]);
  });

  it("lists both exit-trigger events for OPEN", () => {
    expect(validEventsFrom("OPEN")).toEqual(["STRATEGY_EXIT_APPROVED", "RISK_FORCE_CLOSE"]);
  });

  it("lists both of IDLE's outgoing events (enter or get vetoed)", () => {
    expect(validEventsFrom("IDLE")).toEqual(["INTENT_RECORDED", "RISK_VETOED"]);
  });
});
