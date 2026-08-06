import { describe, expect, it } from "vitest";
import {
  ALL_STATES,
  TRANSITIONS,
  isStuck,
  transition,
  validEventsFrom,
} from "../../src/execution/pairIntentState.js";
import type { PairIntentState } from "../../src/execution/pairIntentState.js";

describe("transition — every documented edge from ARCHITECTURE.md §4", () => {
  it.each(TRANSITIONS.map((t) => [t.from, t.event, t.to] as const))(
    "%s + %s -> %s",
    (from, event, to) => {
      expect(transition(from, event)).toBe(to);
    },
  );
});

describe("transition — the specific edge execution/ exists to handle", () => {
  it("LEG2_SENT + REJECTED -> UNWINDING_LEG1 (ARCHITECTURE.md: 'ровно тот сценарий, ради которого написан весь модуль execution/')", () => {
    expect(transition("LEG2_SENT", "REJECTED")).toBe("UNWINDING_LEG1");
  });

  it("RECOVERY + CONFIRMED_ONE_LEG -> STUCK_LEG (RR-10 violated by an external cause, not recoverable automatically)", () => {
    expect(transition("RECOVERY", "CONFIRMED_ONE_LEG")).toBe("STUCK_LEG");
  });

  it("both OPEN exit triggers (strategy-decided and risk-forced) land on the same EXIT_PENDING state", () => {
    expect(transition("OPEN", "STRATEGY_EXIT_APPROVED")).toBe("EXIT_PENDING");
    expect(transition("OPEN", "RISK_FORCE_CLOSE")).toBe("EXIT_PENDING");
  });

  it("OPEN + RECONCILED_OK is a self-loop (routine reconciliation success stays in OPEN)", () => {
    expect(transition("OPEN", "RECONCILED_OK")).toBe("OPEN");
  });
});

describe("transition — rejects undocumented transitions instead of guessing", () => {
  it("throws for an event that doesn't apply in the given state", () => {
    expect(() => transition("IDLE", "FILLED")).toThrow(/Invalid state transition/);
  });

  it("throws for any attempt to leave STUCK_LEG — it is terminal by design", () => {
    for (const event of [
      "RESUME_CONFIRMED",
      "INTENT_RECORDED",
      "CONFIRMED_FLAT",
    ] as const) {
      expect(() => transition("STUCK_LEG", event)).toThrow(/Invalid state transition/);
    }
  });

  it("error message names both the offending state and event, for a log line that's actually diagnosable", () => {
    expect(() => transition("CLOSED", "TIMEOUT")).toThrow(/"TIMEOUT".*"CLOSED"/s);
  });
});

describe("graph well-formedness (validates the transcription, not just individual edges)", () => {
  it("every transition references states that exist in ALL_STATES (catches a typo in either list)", () => {
    for (const t of TRANSITIONS) {
      expect(ALL_STATES).toContain(t.from);
      expect(ALL_STATES).toContain(t.to);
    }
  });

  it("every state except STUCK_LEG has at least one outgoing transition", () => {
    for (const state of ALL_STATES) {
      const outgoing = TRANSITIONS.filter((t) => t.from === state);
      if (state === "STUCK_LEG") {
        expect(outgoing).toHaveLength(0);
      } else {
        expect(outgoing.length).toBeGreaterThan(0);
      }
    }
  });

  it("every state except IDLE has at least one incoming transition (nothing is unreachable)", () => {
    for (const state of ALL_STATES) {
      const incoming = TRANSITIONS.filter((t) => t.to === state);
      if (state === "IDLE") {
        expect(incoming.length).toBeGreaterThan(0); // IDLE too, in fact — it's re-entered, just not required to be
      } else {
        expect(incoming.length).toBeGreaterThan(0);
      }
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
    const reachable = new Set<PairIntentState>(["IDLE"]);
    let frontier = ["IDLE" as PairIntentState];
    while (frontier.length > 0) {
      const next: PairIntentState[] = [];
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
});

describe("validEventsFrom", () => {
  it("lists exactly the events with a defined edge from a given state", () => {
    expect(validEventsFrom("LEG1_REJECTED")).toEqual(["INTENT_CANCELLED"]);
  });

  it("returns an empty array for STUCK_LEG", () => {
    expect(validEventsFrom("STUCK_LEG")).toEqual([]);
  });

  it("lists both exit-trigger events for OPEN", () => {
    const events = validEventsFrom("OPEN");
    expect(events).toContain("STRATEGY_EXIT_APPROVED");
    expect(events).toContain("RISK_FORCE_CLOSE");
    expect(events).toContain("RECONCILED_OK");
  });
});

describe("isStuck", () => {
  it("is true only for STUCK_LEG", () => {
    expect(isStuck("STUCK_LEG")).toBe(true);
    expect(isStuck("OPEN")).toBe(false);
    expect(isStuck("IDLE")).toBe(false);
  });
});
