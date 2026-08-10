import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  computeAllocation,
  computeWorkingPct,
  describeAllocationConflicts,
  notionalForCapital,
  DEFAULT_ALLOCATION_POLICY,
  OWNER_80_20_POLICY,
} from "../../src/strategy/capitalAllocation.js";
import type { AllocationPolicy, TradeResult } from "../../src/strategy/capitalAllocation.js";

function win(pnl: string, equity = "1000"): TradeResult {
  return { realizedPnl: new Big(pnl), equityAtClose: new Big(equity) };
}

describe("notionalForCapital — the two-leg factor", () => {
  it("halves the capital at leverage 1.0: $1000 of capital buys only $500 of notional per leg", () => {
    // The whole point of the module: spot leg $500 + perp margin $500 = $1000
    // committed, but funding only ever accrues on the $500 notional.
    expect(notionalForCapital(new Big("1000"), new Big("1")).toString()).toBe("500");
  });

  it("recovers more notional per capital dollar as leverage rises", () => {
    // capital = N * (1 + 1/L); at L=4, N = 1000 / 1.25 = 800.
    expect(notionalForCapital(new Big("1000"), new Big("4")).toString()).toBe("800");
  });

  it("rejects leverage below 1 rather than silently inflating notional", () => {
    expect(() => notionalForCapital(new Big("1000"), new Big("0.5"))).toThrow(RangeError);
  });
});

describe("computeWorkingPct — anti-martingale band", () => {
  const policy = DEFAULT_ALLOCATION_POLICY;

  it("returns the neutral fraction with no history", () => {
    expect(computeWorkingPct([], policy).toString()).toBe("0.4");
  });

  it("does NOT step up on a single isolated win — only streaks move the needle", () => {
    expect(computeWorkingPct([win("10")], policy).toString()).toBe("0.4");
  });

  it("steps up on two consecutive wins", () => {
    expect(computeWorkingPct([win("10"), win("10")], policy).toString()).toBe("0.45");
  });

  it("ignores an ordinary (non-significant) loss", () => {
    // -$10 on $1000 equity = -1%, under the 3% significance bar.
    expect(computeWorkingPct([win("-10")], policy).toString()).toBe("0.4");
  });

  it("steps down on a significant loss (worse than -3% of equity)", () => {
    expect(computeWorkingPct([win("-50")], policy).toString()).toBe("0.35");
  });

  it("never falls below the floor no matter how long the losing streak", () => {
    const losses = Array.from({ length: 20 }, () => win("-100"));
    expect(computeWorkingPct(losses, policy).toString()).toBe("0.3");
  });

  it("never rises above the ceiling no matter how long the winning streak", () => {
    const wins = Array.from({ length: 20 }, () => win("50"));
    expect(computeWorkingPct(wins, policy).toString()).toBe("0.5");
  });

  it("treats a wiped-out account as a significant loss, never as neutral", () => {
    expect(computeWorkingPct([{ realizedPnl: new Big("5"), equityAtClose: new Big("0") }], policy).toString()).toBe(
      "0.35",
    );
  });
});

describe("computeAllocation — the split", () => {
  it("carves the cushion out first and never lets staking touch it", () => {
    const a = computeAllocation(new Big("1000"), [], DEFAULT_ALLOCATION_POLICY);
    expect(a.cushion.toString()).toBe("200"); // 20% of 1000, untouchable
    expect(a.workingCapital.toString()).toBe("400"); // neutral 40%
    // Idle = 1000 - 200 cushion - 400 working = 400; stake cap = 20% = 200.
    expect(a.stakeableCapital.toString()).toBe("200");
    expect(a.idleLiquid.toString()).toBe("200");
    // Cushion + working + stakeable + idleLiquid must reconstruct the deposit.
    expect(a.cushion.plus(a.workingCapital).plus(a.stakeableCapital).plus(a.idleLiquid).toString()).toBe("1000");
  });

  it("reports notional as HALF the working capital at leverage 1 — the number funding actually accrues on", () => {
    const a = computeAllocation(new Big("1000"), [], DEFAULT_ALLOCATION_POLICY);
    expect(a.workingCapital.toString()).toBe("400");
    expect(a.maxNotional.toString()).toBe("200");
  });

  it("raises the stake cap when the strategy is idling below the utilization threshold", () => {
    // Drive the band to its 0.30 floor, which is below lowUtilizationThresholdPct 0.40.
    const losses = Array.from({ length: 10 }, () => win("-100"));
    const a = computeAllocation(new Big("1000"), losses, DEFAULT_ALLOCATION_POLICY);
    expect(a.workingPct.toString()).toBe("0.3");
    // Idle = 1000 - 200 - 300 = 500; elevated cap 35% = 350 now applies, not 200.
    expect(a.stakeableCapital.toString()).toBe("350");
  });

  it("never overdraws the cushion even if the policy band asks for more than what is left", () => {
    const greedy: AllocationPolicy = {
      ...DEFAULT_ALLOCATION_POLICY,
      neutralWorkingPct: new Big("0.95"),
      maxWorkingPct: new Big("0.95"),
      minWorkingPct: new Big("0.95"),
    };
    const a = computeAllocation(new Big("1000"), [], greedy);
    expect(a.cushion.toString()).toBe("200");
    expect(a.workingCapital.toString()).toBe("800"); // clamped to what remains, not 950
    expect(a.idleLiquid.toString()).toBe("0");
  });
});

describe("describeAllocationConflicts — catches the '80% working' request", () => {
  const CONCENTRATION_MAX = new Big("0.25"); // risk/leverage.ts

  it("passes the shipped default clean against the real concentration cap", () => {
    expect(describeAllocationConflicts(DEFAULT_ALLOCATION_POLICY, CONCENTRATION_MAX)).toEqual([]);
  });

  it("flags an 80% working ceiling as breaching the single-coin notional cap", () => {
    const owner: AllocationPolicy = {
      ...DEFAULT_ALLOCATION_POLICY,
      neutralWorkingPct: new Big("0.50"),
      minWorkingPct: new Big("0.40"),
      maxWorkingPct: new Big("0.80"),
    };
    const problems = describeAllocationConflicts(owner, CONCENTRATION_MAX);
    // 0.80 capital / 2 = 0.40 notional > 0.25 cap.
    expect(problems.some((p) => p.includes("CONCENTRATION_MAX"))).toBe(true);
  });

  it("flags a band whose ceiling plus cushion cannot physically fit in the deposit", () => {
    const impossible: AllocationPolicy = {
      ...DEFAULT_ALLOCATION_POLICY,
      maxWorkingPct: new Big("0.90"),
      cushionPct: new Big("0.20"),
    };
    const problems = describeAllocationConflicts(impossible, new Big("1"));
    expect(problems.some((p) => p.includes("exceeds 100% of equity"))).toBe(true);
  });

  it("flags an inverted band", () => {
    const inverted: AllocationPolicy = {
      ...DEFAULT_ALLOCATION_POLICY,
      minWorkingPct: new Big("0.60"),
      maxWorkingPct: new Big("0.30"),
    };
    expect(describeAllocationConflicts(inverted, CONCENTRATION_MAX).length).toBeGreaterThan(0);
  });
});

describe("OWNER_80_20_POLICY — the owner's stated split", () => {
  it("splits $1000 into $800 working / $200 cushion at the top of the band", () => {
    const wins = Array.from({ length: 20 }, () => win("50"));
    const a = computeAllocation(new Big("1000"), wins, OWNER_80_20_POLICY);
    expect(a.workingPct.toString()).toBe("0.8");
    expect(a.workingCapital.toString()).toBe("800");
    expect(a.cushion.toString()).toBe("200");
    expect(a.idleLiquid.toString()).toBe("0"); // nothing left over — cushion IS the stake
  });

  it("scales linearly to $2000 -> $1600 / $400", () => {
    const wins = Array.from({ length: 20 }, () => win("50", "2000"));
    const a = computeAllocation(new Big("2000"), wins, OWNER_80_20_POLICY);
    expect(a.workingCapital.toString()).toBe("1600");
    expect(a.cushion.toString()).toBe("400");
  });

  it("funds only $400 of NOTIONAL from $800 of capital — the number funding accrues on", () => {
    const wins = Array.from({ length: 20 }, () => win("50"));
    const a = computeAllocation(new Big("1000"), wins, OWNER_80_20_POLICY);
    expect(a.maxNotional.toString()).toBe("400");
  });

  it("needs the concentration cap raised to 0.40 — reports the conflict against the real 0.25", () => {
    const problems = describeAllocationConflicts(OWNER_80_20_POLICY, new Big("0.25"));
    expect(problems.some((p) => p.includes("CONCENTRATION_MAX"))).toBe(true);
    // ...and is clean once the cap is raised to exactly what the split implies.
    expect(describeAllocationConflicts(OWNER_80_20_POLICY, new Big("0.40"))).toEqual([]);
  });
});
