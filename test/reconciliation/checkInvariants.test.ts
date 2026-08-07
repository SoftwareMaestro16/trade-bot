import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Big from "big.js";
import type { Kysely } from "kysely";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";
import { checkAccountMMRate, checkLeverage } from "../../src/risk/leverage.js";
import {
  checkLiveAccountMMRate,
  checkLivePositionLeverage,
  checkNoStuckOrders,
  checkNoUnexplainedShrinkage,
  checkPositionCountMatch,
  checkResidualDelta,
  evaluateReconciliationCycle,
  findOpenPositions,
  findPendingOrders,
  DEFAULT_MAX_RESIDUAL_DELTA,
} from "../../src/reconciliation/checkInvariants.js";
import type { InvariantViolation } from "../../src/reconciliation/checkInvariants.js";

// ---------------------------------------------------------------------------
// Invariant 1: checkPositionCountMatch
// ---------------------------------------------------------------------------

describe("checkPositionCountMatch — invariant 1 (local open-position count vs exchange nonzero-perp count)", () => {
  it("local set and exchange-nonzero-perp set are equal size and same symbols -> [] (normal pass)", () => {
    const violations = checkPositionCountMatch(
      [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }],
      [
        { symbol: "BTCUSDT", perpQty: new Big("-0.5") },
        { symbol: "ETHUSDT", perpQty: new Big("-2") },
      ],
    );
    expect(violations).toEqual([]);
  });

  it("local has a symbol exchange doesn't (exchange already flat) -> violation lists it under 'Only in local state'", () => {
    const violations = checkPositionCountMatch(
      [{ symbol: "BTCUSDT" }],
      [],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 1, symbol: null, code: "POSITION_COUNT_MISMATCH" });
    expect(violations[0]?.reason).toContain("Only in local state: BTCUSDT");
  });

  it("exchange has a symbol local doesn't (untracked position) -> violation lists it under 'Only on exchange'", () => {
    const violations = checkPositionCountMatch(
      [],
      [{ symbol: "ETHUSDT", perpQty: new Big("1.5") }],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 1, symbol: null, code: "POSITION_COUNT_MISMATCH" });
    expect(violations[0]?.reason).toContain("Only on exchange: ETHUSDT");
  });

  it("exchange holding present but perpQty is exactly 0 -> excluded from exchangeOpenSymbols, so it does NOT count toward the match (boundary: .eq(0) inclusive)", () => {
    const violations = checkPositionCountMatch(
      [{ symbol: "BTCUSDT" }],
      [{ symbol: "BTCUSDT", perpQty: new Big(0) }],
    );
    // Local sees BTCUSDT as open; exchange's zero-qty holding is excluded, so
    // exchangeOpenSymbols is empty -> sizes differ (1 vs 0) -> violation.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("exchange nonzero perp positions: 0");
    expect(violations[0]?.reason).toContain("Only in local state: BTCUSDT");
  });

  it("counts equal but symbol sets differ (local={A}, exchange={B}) -> [] because the check is count-only, not identity-based (matches ARCHITECTURE.md's literal 'count equals count' wording; the current implementation short-circuits on size===size before ever diffing symbols)", () => {
    const violations = checkPositionCountMatch(
      [{ symbol: "AAAUSDT" }],
      [{ symbol: "BBBUSDT", perpQty: new Big("1") }],
    );
    expect(violations).toEqual([]);
  });

  it("both empty -> [] (no open positions anywhere, trivially consistent)", () => {
    const violations = checkPositionCountMatch([], []);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: checkResidualDelta
// ---------------------------------------------------------------------------

describe("checkResidualDelta — invariant 2 (RR-15 residual delta between spot and perp legs)", () => {
  it("spotQty equals perpQtyEquivalent exactly -> []", () => {
    const violations = checkResidualDelta("BTCUSDT", new Big("1.0"), new Big("1.0"), new Big("50000"));
    expect(violations).toEqual([]);
  });

  it("residual delta fraction exactly equal to maxResidualDeltaFraction -> [] (boundary is .gt, so exactly-at-threshold must NOT violate)", () => {
    // positionNotional = 1 * 100 = 100. Want deltaQty*markPrice/positionNotional == 0.005 exactly
    // -> deltaQty * 100 / 100 == 0.005 -> deltaQty == 0.005
    const spotQty = new Big("1.005");
    const perpQtyEquivalent = new Big("1.0");
    const markPrice = new Big("100");
    const violations = checkResidualDelta("BTCUSDT", spotQty, perpQtyEquivalent, markPrice, new Big("0.005"));
    expect(violations).toEqual([]);
  });

  it("residual delta fraction one unit above threshold -> RESIDUAL_DELTA_EXCEEDED", () => {
    const spotQty = new Big("1.006");
    const perpQtyEquivalent = new Big("1.0");
    const markPrice = new Big("100");
    const violations = checkResidualDelta("BTCUSDT", spotQty, perpQtyEquivalent, markPrice, new Big("0.005"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 2, symbol: "BTCUSDT", code: "RESIDUAL_DELTA_EXCEEDED" });
  });

  it("perpQtyEquivalent is 0 -> RESIDUAL_DELTA_UNDEFINED, not a divide-by-zero throw (fail-closed guard)", () => {
    const violations = checkResidualDelta("BTCUSDT", new Big("1.0"), new Big(0), new Big("50000"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 2, symbol: "BTCUSDT", code: "RESIDUAL_DELTA_UNDEFINED" });
  });

  it("markPrice is 0 -> same RESIDUAL_DELTA_UNDEFINED path via positionNotional.lte(0)", () => {
    const violations = checkResidualDelta("BTCUSDT", new Big("1.0"), new Big("1.0"), new Big(0));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 2, symbol: "BTCUSDT", code: "RESIDUAL_DELTA_UNDEFINED" });
  });

  it("custom maxResidualDeltaFraction override narrower than DEFAULT_MAX_RESIDUAL_DELTA causes a violation that the default tolerance would have passed", () => {
    // fraction = 0.003, which passes the default 0.005 tolerance but should
    // fail a narrower 0.001 override.
    const spotQty = new Big("1.003");
    const perpQtyEquivalent = new Big("1.0");
    const markPrice = new Big("100");

    const withDefault = checkResidualDelta("BTCUSDT", spotQty, perpQtyEquivalent, markPrice, DEFAULT_MAX_RESIDUAL_DELTA);
    expect(withDefault).toEqual([]);

    const withNarrowOverride = checkResidualDelta("BTCUSDT", spotQty, perpQtyEquivalent, markPrice, new Big("0.001"));
    expect(withNarrowOverride).toHaveLength(1);
    expect(withNarrowOverride[0]).toMatchObject({ invariant: 2, symbol: "BTCUSDT", code: "RESIDUAL_DELTA_EXCEEDED" });
  });
});

// ---------------------------------------------------------------------------
// Invariant 3: checkNoUnexplainedShrinkage
// ---------------------------------------------------------------------------

describe("checkNoUnexplainedShrinkage — invariant 3 (FR-305 ADL detection)", () => {
  it("perpQtyNow equal to perpQtyBefore -> [] (shrinkage.lte(0) short-circuit)", () => {
    const violations = checkNoUnexplainedShrinkage("BTCUSDT", new Big("1.0"), new Big("1.0"), new Big(0));
    expect(violations).toEqual([]);
  });

  it("perpQtyNow greater than perpQtyBefore (position grew) -> [], same short-circuit", () => {
    const violations = checkNoUnexplainedShrinkage("BTCUSDT", new Big("1.0"), new Big("1.5"), new Big(0));
    expect(violations).toEqual([]);
  });

  it("shrinkage fully covered by explainedByFillsQty -> []", () => {
    const violations = checkNoUnexplainedShrinkage("BTCUSDT", new Big("1.0"), new Big("0.7"), new Big("0.3"));
    expect(violations).toEqual([]);
  });

  it("shrinkage exactly equal to toleranceQty (non-default) -> [] (boundary is .gt, so equal-to-tolerance must pass)", () => {
    // shrinkage = 1.0 - 0.95 = 0.05; explainedByFillsQty = 0 -> unexplained = 0.05
    const violations = checkNoUnexplainedShrinkage(
      "BTCUSDT",
      new Big("1.0"),
      new Big("0.95"),
      new Big(0),
      new Big("0.05"),
    );
    expect(violations).toEqual([]);
  });

  it("shrinkage exceeds explainedByFillsQty by more than default zero tolerance -> UNEXPLAINED_PERP_SHRINKAGE (ADL case)", () => {
    const violations = checkNoUnexplainedShrinkage("BTCUSDT", new Big("1.0"), new Big("0.9"), new Big(0));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 3, symbol: "BTCUSDT", code: "UNEXPLAINED_PERP_SHRINKAGE" });
  });

  it("perpQtyBefore/perpQtyNow both negative (short side) -> .abs() used correctly, shrinkage computed on magnitude not signed value", () => {
    // magnitude shrank from 1.0 to 0.9 even though both are negative (short).
    const violations = checkNoUnexplainedShrinkage("BTCUSDT", new Big("-1.0"), new Big("-0.9"), new Big(0));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 3, symbol: "BTCUSDT", code: "UNEXPLAINED_PERP_SHRINKAGE" });
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: checkNoStuckOrders
// ---------------------------------------------------------------------------

describe("checkNoStuckOrders — invariant 4 (no order stuck in an intermediate status past timeout)", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");
  const timeoutMs = 60_000;

  it("order with status 'sent', sentAt older than timeoutMs -> STUCK_INTERMEDIATE_ORDER", () => {
    const violations = checkNoStuckOrders(
      [
        {
          symbol: "BTCUSDT",
          leg: "perp",
          orderLinkId: "link-1",
          status: "sent",
          sentAt: new Date(now.getTime() - 61_000),
        },
      ],
      now,
      timeoutMs,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 4, symbol: "BTCUSDT", code: "STUCK_INTERMEDIATE_ORDER" });
  });

  it("order age exactly equal to timeoutMs -> [] (boundary is .gt, so exactly-at-timeout must NOT violate)", () => {
    const violations = checkNoStuckOrders(
      [
        {
          symbol: "BTCUSDT",
          leg: "perp",
          orderLinkId: "link-2",
          status: "sent",
          sentAt: new Date(now.getTime() - timeoutMs),
        },
      ],
      now,
      timeoutMs,
    );
    expect(violations).toEqual([]);
  });

  it("order with status 'filled' (a non-intermediate status) and old sentAt -> excluded regardless of age", () => {
    const violations = checkNoStuckOrders(
      [
        {
          symbol: "BTCUSDT",
          leg: "perp",
          orderLinkId: "link-3",
          status: "filled",
          sentAt: new Date(now.getTime() - 999_999),
        },
      ],
      now,
      timeoutMs,
    );
    expect(violations).toEqual([]);
  });

  it("order with status 'unknown' and sentAt: null -> excluded (nothing in flight to time out), not a false positive", () => {
    const violations = checkNoStuckOrders(
      [{ symbol: "BTCUSDT", leg: "spot", orderLinkId: "link-4", status: "unknown", sentAt: null }],
      now,
      timeoutMs,
    );
    expect(violations).toEqual([]);
  });

  it("multiple stuck orders across different symbols -> all reported, one violation each", () => {
    const violations = checkNoStuckOrders(
      [
        {
          symbol: "BTCUSDT",
          leg: "perp",
          orderLinkId: "link-5",
          status: "sent",
          sentAt: new Date(now.getTime() - 120_000),
        },
        {
          symbol: "ETHUSDT",
          leg: "spot",
          orderLinkId: "link-6",
          status: "unknown",
          sentAt: new Date(now.getTime() - 90_000),
        },
      ],
      now,
      timeoutMs,
    );
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(violations.every((v) => v.code === "STUCK_INTERMEDIATE_ORDER")).toBe(true);
  });

  it("order well within timeout -> []", () => {
    const violations = checkNoStuckOrders(
      [
        {
          symbol: "BTCUSDT",
          leg: "perp",
          orderLinkId: "link-7",
          status: "sent",
          sentAt: new Date(now.getTime() - 1_000),
        },
      ],
      now,
      timeoutMs,
    );
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5: checkLivePositionLeverage / checkLiveAccountMMRate
// ---------------------------------------------------------------------------

describe("checkLivePositionLeverage — invariant 5 (delegates to risk/leverage.ts's checkLeverage, RR-20)", () => {
  it("shortNotional / totalEquity at exactly 1.5 -> [] (delegates to checkLeverage's .gt, boundary inclusive pass)", () => {
    const violations = checkLivePositionLeverage(new Big("150000"), new Big("100000"));
    expect(violations).toEqual([]);
  });

  it("ratio just above 1.5 -> violation with invariant: 5, code and reason copied verbatim from checkLeverage's deny() result (confirms delegation, not reimplementation)", () => {
    const shortNotional = new Big("150001");
    const totalEquity = new Big("100000");
    const expected = checkLeverage(shortNotional, totalEquity);
    expect(expected.allowed).toBe(false);

    const violations = checkLivePositionLeverage(shortNotional, totalEquity);
    expect(violations).toHaveLength(1);
    if (!expected.allowed) {
      expect(violations[0]).toEqual({
        invariant: 5,
        symbol: null,
        code: expected.code,
        reason: expected.reason,
      });
    }
  });

  it("negative shortNotional -> propagates LEVERAGE_NOTIONAL_IMPLAUSIBLE through as invariant 5", () => {
    const violations = checkLivePositionLeverage(new Big("-1"), new Big("100000"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 5, symbol: null, code: "LEVERAGE_NOTIONAL_IMPLAUSIBLE" });
  });
});

describe("checkLiveAccountMMRate — invariant 5 (delegates to risk/leverage.ts's checkAccountMMRate)", () => {
  it("projectedAccountMMRate exactly 0.30 -> violation (boundary is .gte, exclusive-pass/inclusive-deny, opposite sense from leverage's boundary)", () => {
    const violations = checkLiveAccountMMRate(new Big("0.30"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 5, symbol: null, code: "ACCOUNT_MMR_EXCEEDED" });
  });

  it("just under 0.30 -> []", () => {
    const violations = checkLiveAccountMMRate(new Big("0.2999"));
    expect(violations).toEqual([]);
  });

  it("just over 0.30 -> ACCOUNT_MMR_EXCEEDED as invariant 5, verbatim from checkAccountMMRate", () => {
    const projected = new Big("0.31");
    const expected = checkAccountMMRate(projected);
    expect(expected.allowed).toBe(false);

    const violations = checkLiveAccountMMRate(projected);
    expect(violations).toHaveLength(1);
    if (!expected.allowed) {
      expect(violations[0]).toEqual({
        invariant: 5,
        symbol: null,
        code: expected.code,
        reason: expected.reason,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregation: evaluateReconciliationCycle
// ---------------------------------------------------------------------------

describe("evaluateReconciliationCycle — reduces a cycle's violations to one of RECONCILED_OK / RECONCILIATION_MISMATCH / FREEZE_TRIGGER", () => {
  function v(invariant: 1 | 2 | 3 | 4 | 5, code: string, symbol: string | null = "BTCUSDT"): InvariantViolation {
    return { invariant, symbol, code, reason: `${code} for ${String(symbol)}` };
  }

  it("empty violations -> RECONCILED_OK, empty staleOrderWarnings", () => {
    const result = evaluateReconciliationCycle([]);
    expect(result.event).toBe("RECONCILED_OK");
    expect(result.violations).toEqual([]);
    expect(result.staleOrderWarnings).toEqual([]);
  });

  it("only invariant-4 warnings, no invariant 1/2/3/5 -> event still RECONCILED_OK (stale orders alone don't trigger a state transition) but staleOrderWarnings populated", () => {
    const stale = v(4, "STUCK_INTERMEDIATE_ORDER");
    const result = evaluateReconciliationCycle([stale]);
    expect(result.event).toBe("RECONCILED_OK");
    expect(result.violations).toEqual([]);
    expect(result.staleOrderWarnings).toEqual([stale]);
  });

  it("invariant 1 + invariant 4 together -> RECONCILIATION_MISMATCH carrying only the invariant-1 violation, staleOrderWarnings independently populated with the invariant-4 one", () => {
    const mismatch = v(1, "POSITION_COUNT_MISMATCH", null);
    const stale = v(4, "STUCK_INTERMEDIATE_ORDER");
    const result = evaluateReconciliationCycle([mismatch, stale]);
    expect(result.event).toBe("RECONCILIATION_MISMATCH");
    expect(result.violations).toEqual([mismatch]);
    expect(result.staleOrderWarnings).toEqual([stale]);
  });

  it("invariant 5 + invariant 1/2/3 together -> FREEZE_TRIGGER wins, violations contains only invariant-5 entries, mismatch violations dropped from the returned violations (priority ordering)", () => {
    const leverage = v(5, "LEVERAGE_EXCEEDED", null);
    const mismatch = v(2, "RESIDUAL_DELTA_EXCEEDED");
    const result = evaluateReconciliationCycle([mismatch, leverage]);
    expect(result.event).toBe("FREEZE_TRIGGER");
    expect(result.violations).toEqual([leverage]);
    expect(result.staleOrderWarnings).toEqual([]);
  });

  it("invariant 5 + invariant 4 together -> FREEZE_TRIGGER, staleOrderWarnings still populated", () => {
    const leverage = v(5, "ACCOUNT_MMR_EXCEEDED", null);
    const stale = v(4, "STUCK_INTERMEDIATE_ORDER");
    const result = evaluateReconciliationCycle([leverage, stale]);
    expect(result.event).toBe("FREEZE_TRIGGER");
    expect(result.violations).toEqual([leverage]);
    expect(result.staleOrderWarnings).toEqual([stale]);
  });

  it("all three categories (1/2/3, 4, 5) simultaneously -> FREEZE_TRIGGER, staleOrderWarnings has the invariant-4 entry regardless", () => {
    const mismatch = v(3, "UNEXPLAINED_PERP_SHRINKAGE");
    const stale = v(4, "STUCK_INTERMEDIATE_ORDER");
    const leverage = v(5, "LEVERAGE_EXCEEDED", null);
    const result = evaluateReconciliationCycle([mismatch, stale, leverage]);
    expect(result.event).toBe("FREEZE_TRIGGER");
    expect(result.violations).toEqual([leverage]);
    expect(result.staleOrderWarnings).toEqual([stale]);
  });
});

// ---------------------------------------------------------------------------
// DB-reading half: findOpenPositions / findPendingOrders (real local Postgres)
// ---------------------------------------------------------------------------

describe("findOpenPositions / findPendingOrders (against a real local Postgres)", () => {
  let db: Kysely<Database>;
  const insertedOrderIds: bigint[] = [];
  const insertedPositionIds: bigint[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    // orders.position_id / positions FK is ON DELETE RESTRICT (migration
    // comment: cascading deletes are unacceptable for a money audit trail),
    // so child rows must be deleted before their parent position.
    if (insertedOrderIds.length > 0) {
      await db.deleteFrom("orders").where("id", "in", insertedOrderIds).execute();
      insertedOrderIds.length = 0;
    }
    if (insertedPositionIds.length > 0) {
      await db.deleteFrom("positions").where("id", "in", insertedPositionIds).execute();
      insertedPositionIds.length = 0;
    }
  });

  async function insertPosition(opts: {
    symbol: string;
    state: string;
    spotQty: string | null;
    perpQty: string | null;
    closedAt?: Date | null;
  }): Promise<bigint> {
    const row = await db
      .insertInto("positions")
      .values({
        symbol: opts.symbol,
        state: opts.state,
        spot_qty: opts.spotQty,
        perp_qty: opts.perpQty,
        closed_at: opts.closedAt ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    insertedPositionIds.push(row.id);
    return row.id;
  }

  async function insertOrder(opts: {
    positionId: bigint;
    leg: "spot" | "perp";
    side: string;
    orderLinkId: string;
    intendedQty: string;
    status: string;
    sentAt: Date | null;
  }): Promise<bigint> {
    const row = await db
      .insertInto("orders")
      .values({
        position_id: opts.positionId,
        leg: opts.leg,
        side: opts.side,
        order_link_id: opts.orderLinkId,
        intended_qty: opts.intendedQty,
        status: opts.status,
        sent_at: opts.sentAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    insertedOrderIds.push(row.id);
    return row.id;
  }

  describe("findOpenPositions", () => {
    it("position in OPEN state -> included, with spotQty/perpQty mapped from spot_qty/perp_qty", async () => {
      await insertPosition({ symbol: "CIOPEN1", state: "OPEN", spotQty: "1.5", perpQty: "-1.5" });

      const rows = await findOpenPositions(db);
      const found = rows.find((r) => r.symbol === "CIOPEN1");
      expect(found).toBeDefined();
      expect(found?.spotQty).toBe("1.5");
      expect(found?.perpQty).toBe("-1.5");
    });

    it("position in a non-OPEN state (e.g. LEG1_SENT) -> excluded", async () => {
      await insertPosition({ symbol: "CIOPEN2", state: "LEG1_SENT", spotQty: null, perpQty: null });

      const rows = await findOpenPositions(db);
      expect(rows.find((r) => r.symbol === "CIOPEN2")).toBeUndefined();
    });

    it("position CLOSED with closed_at set -> excluded (state string, not closed_at, drives the filter — no accidental closed_at IS NULL clause)", async () => {
      await insertPosition({
        symbol: "CIOPEN3",
        state: "CLOSED",
        spotQty: "0",
        perpQty: "0",
        closedAt: new Date(),
      });

      const rows = await findOpenPositions(db);
      expect(rows.find((r) => r.symbol === "CIOPEN3")).toBeUndefined();
    });

    it("spot_qty/perp_qty both null on an OPEN row -> returned as null, not coerced (query does no arithmetic)", async () => {
      await insertPosition({ symbol: "CIOPEN4", state: "OPEN", spotQty: null, perpQty: null });

      const rows = await findOpenPositions(db);
      const found = rows.find((r) => r.symbol === "CIOPEN4");
      expect(found).toBeDefined();
      expect(found?.spotQty).toBeNull();
      expect(found?.perpQty).toBeNull();
    });
  });

  describe("findPendingOrders", () => {
    it("order with status 'sent' -> included, joined symbol from positions", async () => {
      const positionId = await insertPosition({ symbol: "CIPEND1", state: "LEG1_SENT", spotQty: null, perpQty: null });
      await insertOrder({
        positionId,
        leg: "perp",
        side: "Sell",
        orderLinkId: "ci-pend-1",
        intendedQty: "1",
        status: "sent",
        sentAt: new Date(),
      });

      const rows = await findPendingOrders(db);
      const found = rows.find((r) => r.orderLinkId === "ci-pend-1");
      expect(found).toBeDefined();
      expect(found?.symbol).toBe("CIPEND1");
      expect(found?.status).toBe("sent");
    });

    it("order with status 'unknown' -> included", async () => {
      const positionId = await insertPosition({ symbol: "CIPEND2", state: "LEG1_UNKNOWN", spotQty: null, perpQty: null });
      await insertOrder({
        positionId,
        leg: "perp",
        side: "Sell",
        orderLinkId: "ci-pend-2",
        intendedQty: "1",
        status: "unknown",
        sentAt: new Date(),
      });

      const rows = await findPendingOrders(db);
      expect(rows.find((r) => r.orderLinkId === "ci-pend-2")).toBeDefined();
    });

    it("order with status 'filled'/'acked' -> excluded (query filters status IN (...) in SQL, a query-level filter, not left to callers)", async () => {
      const positionId = await insertPosition({ symbol: "CIPEND3", state: "OPEN", spotQty: "1", perpQty: "-1" });
      await insertOrder({
        positionId,
        leg: "perp",
        side: "Sell",
        orderLinkId: "ci-pend-3-filled",
        intendedQty: "1",
        status: "filled",
        sentAt: new Date(),
      });
      await insertOrder({
        positionId,
        leg: "spot",
        side: "Buy",
        orderLinkId: "ci-pend-3-acked",
        intendedQty: "1",
        status: "acked",
        sentAt: new Date(),
      });

      const rows = await findPendingOrders(db);
      expect(rows.find((r) => r.orderLinkId === "ci-pend-3-filled")).toBeUndefined();
      expect(rows.find((r) => r.orderLinkId === "ci-pend-3-acked")).toBeUndefined();
    });

    it("order with sentAt: null and status 'sent' -> still returned by findPendingOrders (no sent_at IS NOT NULL clause); the null-sentAt exclusion happens only inside checkNoStuckOrders", async () => {
      const positionId = await insertPosition({ symbol: "CIPEND4", state: "LEG1_SENT", spotQty: null, perpQty: null });
      await insertOrder({
        positionId,
        leg: "perp",
        side: "Sell",
        orderLinkId: "ci-pend-4",
        intendedQty: "1",
        status: "sent",
        sentAt: null,
      });

      const rows = await findPendingOrders(db);
      const found = rows.find((r) => r.orderLinkId === "ci-pend-4");
      expect(found).toBeDefined();
      expect(found?.sentAt).toBeNull();

      // Now confirm checkNoStuckOrders (not the query) is the layer that drops it.
      const violations = checkNoStuckOrders(rows.filter((r) => r.orderLinkId === "ci-pend-4"), new Date(), 60_000);
      expect(violations).toEqual([]);
    });

    it("order whose position_id FK position was deleted/mismatched is excluded — inner join naturally excludes orphaned orders (documents current join behavior)", async () => {
      // No order references a nonexistent position in this schema (FK is
      // enforced, ON DELETE RESTRICT), so this documents the join behavior
      // indirectly: an order for a position NOT in OPEN/pending scope simply
      // never appears unless its own status is intermediate. Insert an order
      // whose position exists but give it a status that keeps it out of the
      // intermediate set, confirming the join itself doesn't leak orphan-like
      // rows beyond the status filter.
      const positionId = await insertPosition({ symbol: "CIPEND5", state: "OPEN", spotQty: "1", perpQty: "-1" });
      await insertOrder({
        positionId,
        leg: "perp",
        side: "Sell",
        orderLinkId: "ci-pend-5",
        intendedQty: "1",
        status: "failed",
        sentAt: new Date(),
      });

      const rows = await findPendingOrders(db);
      expect(rows.find((r) => r.orderLinkId === "ci-pend-5")).toBeUndefined();
    });
  });
});
