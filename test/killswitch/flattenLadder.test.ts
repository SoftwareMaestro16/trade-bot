import { describe, expect, it } from "vitest";
import {
  LADDER,
  decideFlattenStep,
  deriveExposureOpen,
  isFlat,
  nextRung,
  sliceReduceOnly,
} from "../../src/killswitch/flattenLadder.js";
import type { FlattenRung, Observation, PerpPosition, AttributedSpot } from "../../src/killswitch/flattenLadder.js";

// --- small builders so each test states only what it cares about ---------------

function perp(over: Partial<PerpPosition> = {}): PerpPosition {
  return { symbol: "BTCUSDT", side: "Buy", size: "1", maxMktOrderQty: "150", qtyStep: "0.001", ...over };
}
function spot(over: Partial<AttributedSpot> = {}): AttributedSpot {
  return { coin: "BTC", qty: "1", dustThreshold: "0.0001", ...over };
}
function obs(over: Partial<Observation> = {}): Observation {
  return { perpPositions: [], attributedSpot: [], ...over };
}
const noneAttempted = new Set<FlattenRung>();

// --- deriveExposureOpen: the FM-30 "success comes from reads" primitive --------

describe("deriveExposureOpen — open exposure is a function of fresh reads (FM-30)", () => {
  it("empty reads => flat", () => {
    const e = deriveExposureOpen(obs());
    expect(isFlat(e)).toBe(true);
  });

  it("a non-zero perp position is open", () => {
    const e = deriveExposureOpen(obs({ perpPositions: [perp({ size: "0.5" })] }));
    expect(e.openPerps).toHaveLength(1);
    expect(isFlat(e)).toBe(false);
  });

  it("a zero-size perp position is NOT open (already closed, still in the list)", () => {
    const e = deriveExposureOpen(obs({ perpPositions: [perp({ size: "0" })] }));
    expect(e.openPerps).toHaveLength(0);
    expect(isFlat(e)).toBe(true);
  });

  it("attributed spot above dust is open; at-or-below dust is not (lot-rounding noise)", () => {
    expect(deriveExposureOpen(obs({ attributedSpot: [spot({ qty: "0.001", dustThreshold: "0.0001" })] })).openSpot).toHaveLength(1);
    expect(deriveExposureOpen(obs({ attributedSpot: [spot({ qty: "0.0001", dustThreshold: "0.0001" })] })).openSpot).toHaveLength(0);
    expect(deriveExposureOpen(obs({ attributedSpot: [spot({ qty: "0.00005", dustThreshold: "0.0001" })] })).openSpot).toHaveLength(0);
  });

  it("throws on a malformed size rather than silently reading it as flat (RSK-56 / FM-30)", () => {
    expect(() => deriveExposureOpen(obs({ perpPositions: [perp({ size: "not-a-number" })] }))).toThrow();
  });

  it("throws on a negative size — side carries direction, an absolute size is never signed", () => {
    expect(() => deriveExposureOpen(obs({ perpPositions: [perp({ size: "-1" })] }))).toThrow(/negative position size/);
  });

  it("throws on negative attributed spot — the ledger floor invariant (RSK-47) is broken", () => {
    expect(() => deriveExposureOpen(obs({ attributedSpot: [spot({ qty: "-1" })] }))).toThrow(/negative attributed spot/);
  });
});

// --- sliceReduceOnly: FM-31 / RSK-39 -------------------------------------------

describe("sliceReduceOnly — chunks respect maxMktOrderQty (FM-31)", () => {
  it("qty at or below the cap is a single chunk", () => {
    expect(sliceReduceOnly("100", "150", "0.001")).toEqual(["100"]);
    expect(sliceReduceOnly("150", "150", "1")).toEqual(["150"]);
  });

  it("the BTCUSDT scenario the mechanism exists for: 1500 sliced under a 150 market cap", () => {
    const slices = sliceReduceOnly("1500", "150", "0.001");
    expect(slices).toEqual(Array(10).fill("150"));
    // every chunk under the cap, and they sum back to the full position
    for (const s of slices) expect(Number(s)).toBeLessThanOrEqual(150);
    expect(slices.reduce((a, s) => a + Number(s), 0)).toBe(1500);
  });

  it("a non-multiple total leaves the true remainder as the last chunk", () => {
    const slices = sliceReduceOnly("325", "150", "1");
    expect(slices).toEqual(["150", "150", "25"]);
    expect(slices.reduce((a, s) => a + Number(s), 0)).toBe(325);
  });

  it("chunk size is floored to a whole number of qtySteps so no chunk is off-step", () => {
    // cap 10, step 3 => largest on-step chunk is 9, not 10
    const slices = sliceReduceOnly("20", "10", "3");
    expect(slices).toEqual(["9", "9", "2"]);
    expect(slices.reduce((a, s) => a + Number(s), 0)).toBe(20);
  });

  it("zero total is an empty slice list, not an error", () => {
    expect(sliceReduceOnly("0", "150", "0.001")).toEqual([]);
  });

  it("keeps decimal quantities exact (no float drift)", () => {
    const slices = sliceReduceOnly("0.005", "0.002", "0.001");
    expect(slices).toEqual(["0.002", "0.002", "0.001"]);
  });

  it("throws when the market cap is smaller than one step — instrument cannot be market-closed", () => {
    expect(() => sliceReduceOnly("10", "0.5", "1")).toThrow(/smaller than one qtyStep/);
  });

  it("throws on a negative total, a non-positive cap, or a non-positive step (caller bugs)", () => {
    expect(() => sliceReduceOnly("-1", "150", "1")).toThrow(/negative totalQty/);
    expect(() => sliceReduceOnly("10", "0", "1")).toThrow(/must be positive/);
    expect(() => sliceReduceOnly("10", "150", "0")).toThrow(/must be positive/);
  });
});

// --- nextRung / LADDER ---------------------------------------------------------

describe("nextRung — monotonic escalation through the documented ladder", () => {
  it("advances CANCEL_ALL -> REDUCE_ONLY_CLOSE -> SELL_SPOT -> null", () => {
    expect(nextRung("CANCEL_ALL")).toBe("REDUCE_ONLY_CLOSE");
    expect(nextRung("REDUCE_ONLY_CLOSE")).toBe("SELL_SPOT");
    expect(nextRung("SELL_SPOT")).toBeNull();
  });

  it("the ladder order matches docs/FLATTEN-LADDER.md §2", () => {
    expect(LADDER).toEqual(["CANCEL_ALL", "REDUCE_ONLY_CLOSE", "SELL_SPOT"]);
  });

  it("rejects a value that is not a rung", () => {
    expect(() => nextRung("NONSENSE" as FlattenRung)).toThrow(/not a ladder rung/);
  });
});

// --- decideFlattenStep: the escalation contract (docs/FLATTEN-LADDER.md §3) -----

describe("decideFlattenStep — CONFIRMED_FLAT comes only from a fresh flat read", () => {
  it("flat read => CONFIRMED_FLAT even before any rung is attempted", () => {
    const d = decideFlattenStep(obs(), noneAttempted);
    expect(d.kind).toBe("CONFIRMED_FLAT");
  });

  it("flat read => CONFIRMED_FLAT even mid-ladder (a close that worked is recognised whatever rung produced it)", () => {
    const d = decideFlattenStep(obs(), new Set<FlattenRung>(["CANCEL_ALL"]));
    expect(d.kind).toBe("CONFIRMED_FLAT");
  });

  it("THE core FM-30 invariant: CANCEL_ALL 'attempted' with exposure still present does NOT mean success — it escalates", () => {
    // A cancel-all that returned without error but left the position open must
    // not be read as done. With CANCEL_ALL marked attempted and a perp still
    // open, the only correct next step is to escalate to REDUCE_ONLY_CLOSE.
    const d = decideFlattenStep(obs({ perpPositions: [perp({ size: "2" })] }), new Set<FlattenRung>(["CANCEL_ALL"]));
    expect(d.kind).toBe("ACT");
    if (d.kind !== "ACT") return;
    expect(d.rung).toBe("REDUCE_ONLY_CLOSE");
  });
});

describe("decideFlattenStep — walks the ladder in order", () => {
  it("first step is always CANCEL_ALL (both categories), even with an open perp", () => {
    const d = decideFlattenStep(obs({ perpPositions: [perp()] }), noneAttempted);
    expect(d.kind).toBe("ACT");
    if (d.kind !== "ACT") return;
    expect(d.rung).toBe("CANCEL_ALL");
    expect(d.actions).toEqual([
      { kind: "CANCEL_ALL", category: "linear" },
      { kind: "CANCEL_ALL", category: "spot" },
    ]);
  });

  it("after CANCEL_ALL, an open perp produces a sliced reduceOnly close on the opposite side", () => {
    const d = decideFlattenStep(
      obs({ perpPositions: [perp({ symbol: "BTCUSDT", side: "Buy", size: "1500", maxMktOrderQty: "150", qtyStep: "0.001" })] }),
      new Set<FlattenRung>(["CANCEL_ALL"]),
    );
    expect(d.kind).toBe("ACT");
    if (d.kind !== "ACT") return;
    expect(d.rung).toBe("REDUCE_ONLY_CLOSE");
    expect(d.actions).toHaveLength(1);
    const a = d.actions[0];
    if (a?.kind !== "REDUCE_ONLY_CLOSE") throw new Error("expected a REDUCE_ONLY_CLOSE action");
    expect(a).toMatchObject({ symbol: "BTCUSDT", closeSide: "Sell" });
    expect(a.slices).toEqual(Array(10).fill("150"));
  });

  it("a short position is closed by BUYing (opposite side)", () => {
    const d = decideFlattenStep(
      obs({ perpPositions: [perp({ side: "Sell", size: "10", maxMktOrderQty: "150", qtyStep: "1" })] }),
      new Set<FlattenRung>(["CANCEL_ALL"]),
    );
    if (d.kind !== "ACT") throw new Error("expected ACT");
    expect(d.actions[0]).toMatchObject({ closeSide: "Buy" });
  });

  it("REDUCE_ONLY_CLOSE with no open perp is skipped; the step falls through to SELL_SPOT", () => {
    const d = decideFlattenStep(
      obs({ attributedSpot: [spot({ coin: "BTC", qty: "1" })] }),
      new Set<FlattenRung>(["CANCEL_ALL"]),
    );
    expect(d.kind).toBe("ACT");
    if (d.kind !== "ACT") return;
    expect(d.rung).toBe("SELL_SPOT");
    expect(d.actions).toEqual([{ kind: "SELL_SPOT", coin: "BTC", qty: "1" }]);
  });

  it("closes every open perp in one REDUCE_ONLY_CLOSE step", () => {
    const d = decideFlattenStep(
      obs({
        perpPositions: [
          perp({ symbol: "BTCUSDT", size: "10", maxMktOrderQty: "150", qtyStep: "1" }),
          perp({ symbol: "ETHUSDT", size: "5", maxMktOrderQty: "100", qtyStep: "1" }),
        ],
      }),
      new Set<FlattenRung>(["CANCEL_ALL"]),
    );
    if (d.kind !== "ACT") throw new Error("expected ACT");
    expect(d.actions).toHaveLength(2);
  });
});

describe("decideFlattenStep — NEEDS_OPERATOR when the ladder is exhausted with exposure left", () => {
  it("all rungs attempted, perp still open => NEEDS_OPERATOR (the STUCK_LEG-equivalent terminal)", () => {
    const d = decideFlattenStep(
      obs({ perpPositions: [perp({ size: "1" })] }),
      new Set<FlattenRung>(["CANCEL_ALL", "REDUCE_ONLY_CLOSE", "SELL_SPOT"]),
    );
    expect(d.kind).toBe("NEEDS_OPERATOR");
    if (d.kind !== "NEEDS_OPERATOR") return;
    expect(d.exposure.openPerps).toHaveLength(1);
    expect(d.reason).toMatch(/manual operator intervention/i);
  });

  it("all rungs attempted, attributed spot still open => NEEDS_OPERATOR", () => {
    const d = decideFlattenStep(
      obs({ attributedSpot: [spot({ qty: "1" })] }),
      new Set<FlattenRung>(["CANCEL_ALL", "REDUCE_ONLY_CLOSE", "SELL_SPOT"]),
    );
    expect(d.kind).toBe("NEEDS_OPERATOR");
  });
});

describe("decideFlattenStep — a full run driven the way the live supervisor will drive it", () => {
  it("cancel-all -> reduceOnly close -> confirmed flat, re-deriving from a fresh read each step", () => {
    // Step 1: open perp, nothing attempted. Expect CANCEL_ALL.
    const attempted = new Set<FlattenRung>();
    let observation: Observation = obs({ perpPositions: [perp({ symbol: "BTCUSDT", side: "Buy", size: "300", maxMktOrderQty: "150", qtyStep: "1" })] });

    let d = decideFlattenStep(observation, attempted);
    expect(d.kind).toBe("ACT");
    if (d.kind === "ACT") expect(d.rung).toBe("CANCEL_ALL");
    attempted.add("CANCEL_ALL");

    // Step 2: cancel-all did nothing to the position (as it wouldn't — it only
    // cancels resting orders). Fresh read still shows the perp. Expect the
    // sliced reduceOnly close. This is the FM-30 point in motion: the run did
    // NOT end just because cancel-all returned.
    d = decideFlattenStep(observation, attempted);
    expect(d.kind).toBe("ACT");
    if (d.kind === "ACT") {
      expect(d.rung).toBe("REDUCE_ONLY_CLOSE");
      const a = d.actions[0];
      if (a?.kind === "REDUCE_ONLY_CLOSE") expect(a.slices).toEqual(["150", "150"]);
    }
    attempted.add("REDUCE_ONLY_CLOSE");

    // Step 3: the close worked — fresh read is now flat. CONFIRMED_FLAT.
    observation = obs();
    d = decideFlattenStep(observation, attempted);
    expect(d.kind).toBe("CONFIRMED_FLAT");
  });
});
