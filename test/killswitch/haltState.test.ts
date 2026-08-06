import { describe, expect, it } from "vitest";
import {
  applyFlattenAll,
  applyHaltNew,
  canCloseExistingPosition,
  canEnterNewPosition,
  CLEARED_STATE,
  clearHalt,
} from "../../src/killswitch/haltState.js";
import type { HaltState } from "../../src/killswitch/haltState.js";

describe("CLEARED_STATE", () => {
  it("is the fully-cleared shape", () => {
    expect(CLEARED_STATE).toEqual({
      haltNew: false,
      flattenAll: false,
      reason: null,
      setBy: null,
      setAtMs: null,
    });
  });
});

describe("applyHaltNew", () => {
  it("sets haltNew true from a cleared state", () => {
    const result = applyHaltNew(CLEARED_STATE, "manual pause", "manual", 1000);
    expect(result).toEqual({
      haltNew: true,
      flattenAll: false,
      reason: "manual pause",
      setBy: "manual",
      setAtMs: 1000,
    });
  });

  it("does not downgrade an already-set flattenAll (RR-52: FLATTEN_ALL is the stronger state)", () => {
    const flattened = applyFlattenAll(CLEARED_STATE, "drawdown breach", "risk:DRAWDOWN_EXCEEDED", 500);
    const result = applyHaltNew(flattened, "manual pause on top", "manual", 900);
    expect(result.flattenAll).toBe(true);
    expect(result.haltNew).toBe(true);
  });

  it("does not mutate the current argument", () => {
    const current: HaltState = {
      haltNew: false,
      flattenAll: true,
      reason: "drawdown breach",
      setBy: "risk:DRAWDOWN_EXCEEDED",
      setAtMs: 500,
    };
    const snapshot = { ...current };
    applyHaltNew(current, "manual pause on top", "manual", 900);
    expect(current).toEqual(snapshot);
  });
});

describe("applyFlattenAll", () => {
  it("sets both haltNew and flattenAll simultaneously (RR-52: FLATTEN_ALL implies HALT_NEW)", () => {
    const result = applyFlattenAll(CLEARED_STATE, "drawdown breach", "risk:DRAWDOWN_EXCEEDED", 500);
    expect(result).toEqual({
      haltNew: true,
      flattenAll: true,
      reason: "drawdown breach",
      setBy: "risk:DRAWDOWN_EXCEEDED",
      setAtMs: 500,
    });
  });

  it("does not mutate the current argument", () => {
    const current: HaltState = { haltNew: true, flattenAll: false, reason: "r", setBy: "manual", setAtMs: 1 };
    const snapshot = { ...current };
    applyFlattenAll(current, "escalate", "risk:X", 2);
    expect(current).toEqual(snapshot);
  });
});

describe("clearHalt", () => {
  it("throws on an empty confirmedBy", () => {
    const halted = applyHaltNew(CLEARED_STATE, "manual pause", "manual", 1000);
    expect(() => clearHalt(halted, "", 2000)).toThrow();
  });

  it("throws on a whitespace-only confirmedBy", () => {
    const halted = applyHaltNew(CLEARED_STATE, "manual pause", "manual", 1000);
    expect(() => clearHalt(halted, "   ", 2000)).toThrow();
  });

  it("returns the cleared state given a valid confirmedBy, even when clearing from flattenAll", () => {
    const flattened = applyFlattenAll(CLEARED_STATE, "drawdown breach", "risk:DRAWDOWN_EXCEEDED", 500);
    const result = clearHalt(flattened, "ops-alice", 2000);
    expect(result).toEqual(CLEARED_STATE);
  });

  it("does not mutate the current argument", () => {
    const current: HaltState = { haltNew: true, flattenAll: true, reason: "r", setBy: "manual", setAtMs: 1 };
    const snapshot = { ...current };
    clearHalt(current, "ops-alice", 2);
    expect(current).toEqual(snapshot);
  });
});

describe("canEnterNewPosition", () => {
  it("is true for CLEARED_STATE", () => {
    expect(canEnterNewPosition(CLEARED_STATE)).toBe(true);
  });

  it("is false when haltNew is set", () => {
    const state: HaltState = { haltNew: true, flattenAll: false, reason: "r", setBy: "manual", setAtMs: 1 };
    expect(canEnterNewPosition(state)).toBe(false);
  });

  it("is false when flattenAll is set", () => {
    const state: HaltState = { haltNew: false, flattenAll: true, reason: "r", setBy: "manual", setAtMs: 1 };
    expect(canEnterNewPosition(state)).toBe(false);
  });

  it("is false when both are set", () => {
    const state: HaltState = { haltNew: true, flattenAll: true, reason: "r", setBy: "manual", setAtMs: 1 };
    expect(canEnterNewPosition(state)).toBe(false);
  });
});

describe("canCloseExistingPosition", () => {
  // RR-52: closing must NEVER be blocked by the kill switch — the reconciler
  // and every closing path are structurally excluded from HALT_NEW, and
  // FLATTEN_ALL's entire purpose is to force closes, not merely permit them.
  // This is the most important test in this file: if it ever regresses,
  // positions could get stuck open during the exact emergency the kill
  // switch exists to handle.
  it("is true for every possible halt state, including flattenAll", () => {
    const states: HaltState[] = [
      CLEARED_STATE,
      { haltNew: true, flattenAll: false, reason: "r", setBy: "manual", setAtMs: 1 },
      { haltNew: false, flattenAll: true, reason: "r", setBy: "manual", setAtMs: 1 },
      { haltNew: true, flattenAll: true, reason: "drawdown breach", setBy: "risk:DRAWDOWN_EXCEEDED", setAtMs: 1 },
    ];
    for (const state of states) {
      expect(canCloseExistingPosition(state)).toBe(true);
    }
  });
});
