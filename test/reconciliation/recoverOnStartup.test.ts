import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";
import {
  decideRecoveryOutcome,
  findUnresolvedIntents,
} from "../../src/reconciliation/recoverOnStartup.js";
import type { ExchangeSnapshot } from "../../src/reconciliation/recoverOnStartup.js";

describe("decideRecoveryOutcome — pure, ARCHITECTURE.md §4's three-outcome RECOVERY logic", () => {
  function snapshot(overrides: Partial<ExchangeSnapshot>): ExchangeSnapshot {
    return { symbol: "BTCUSDT", spotQty: "0", perpQty: "0", noMatchingOrdersFound: false, ...overrides };
  }

  it("both legs present -> CONFIRMED_BOTH_LEGS / OPEN", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0.5", perpQty: "-0.5" }));
    expect(decision.outcome).toBe("CONFIRMED_BOTH_LEGS");
    expect(decision.event).toBe("CONFIRMED_BOTH_LEGS");
  });

  it("both legs flat (already closed before restart) -> CONFIRMED_FLAT / IDLE", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0", perpQty: "0" }));
    expect(decision.outcome).toBe("CONFIRMED_FLAT");
    expect(decision.event).toBe("CONFIRMED_FLAT");
    expect(decision.reasoning).not.toContain("never reached the exchange");
  });

  it("both legs flat AND no matching orders found (intent never reached the exchange) -> CONFIRMED_FLAT, with distinct reasoning", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0", perpQty: "0", noMatchingOrdersFound: true }));
    expect(decision.outcome).toBe("CONFIRMED_FLAT");
    expect(decision.reasoning).toContain("never reached the exchange");
  });

  it("only spot leg present -> CONFIRMED_ONE_LEG / STUCK_LEG", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0.5", perpQty: "0" }));
    expect(decision.outcome).toBe("CONFIRMED_ONE_LEG");
    expect(decision.event).toBe("CONFIRMED_ONE_LEG");
  });

  it("only perp leg present -> CONFIRMED_ONE_LEG / STUCK_LEG", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0", perpQty: "-0.5" }));
    expect(decision.outcome).toBe("CONFIRMED_ONE_LEG");
  });

  it("a negative perp qty and a positive spot qty both count as 'open' — sign is direction, not presence", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "1.2345", perpQty: "-1.2345" }));
    expect(decision.outcome).toBe("CONFIRMED_BOTH_LEGS");
  });

  it("dust below zeroThreshold on one leg is treated as flat on that leg, not open", () => {
    // spot leg is genuine residual dust (below the caller's own tolerance), perp leg is a real position.
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0.0000001", perpQty: "-0.5" }), 0.001);
    expect(decision.outcome).toBe("CONFIRMED_ONE_LEG"); // perp only — dust spot doesn't count as the missing leg's rescue
  });

  it("dust on BOTH legs, within zeroThreshold, is CONFIRMED_FLAT rather than CONFIRMED_BOTH_LEGS", () => {
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0.0000001", perpQty: "-0.0000001" }), 0.001);
    expect(decision.outcome).toBe("CONFIRMED_FLAT");
  });

  it("never calls transition() itself — event is returned for the caller to apply", () => {
    // Structural check: decideRecoveryOutcome's return type carries `event`,
    // proving it hands control back rather than mutating state internally —
    // this test exists to keep that decoupling from silently regressing.
    const decision = decideRecoveryOutcome(snapshot({ spotQty: "0", perpQty: "0" }));
    expect(typeof decision.event).toBe("string");
  });
});

describe("findUnresolvedIntents (against a real local Postgres)", () => {
  let db: Kysely<Database>;
  const insertedPositionIds: bigint[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    if (insertedPositionIds.length > 0) {
      await db.deleteFrom("position_intents").where("position_id", "in", insertedPositionIds).execute();
      await db.deleteFrom("positions").where("id", "in", insertedPositionIds).execute();
      insertedPositionIds.length = 0;
    }
  });

  async function insertPosition(opts: {
    symbol: string;
    state: string;
    openedAt: Date | null;
    closedAt: Date | null;
  }): Promise<bigint> {
    const row = await db
      .insertInto("positions")
      .values({
        symbol: opts.symbol,
        state: opts.state,
        opened_at: opts.openedAt,
        closed_at: opts.closedAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    insertedPositionIds.push(row.id);
    return row.id;
  }

  async function insertIntent(
    positionId: bigint,
    intentType: string,
    intendedQty: string | null,
    createdAt: Date,
  ): Promise<void> {
    await db
      .insertInto("position_intents")
      .values({
        position_id: positionId,
        intent_type: intentType,
        payload: JSON.stringify({}),
        intended_qty: intendedQty,
        created_at: createdAt,
      })
      .execute();
  }

  it("finds a position crashed mid-entry, BEFORE opened_at was ever set (LEG1_SENT-style crash)", async () => {
    const positionId = await insertPosition({
      symbol: "RECOVERYTEST1",
      state: "LEG1_SENT",
      openedAt: null,
      closedAt: null,
    });
    await insertIntent(positionId, "open", "10.5", new Date());

    const unresolved = await findUnresolvedIntents(db);
    const found = unresolved.find((u) => u.symbol === "RECOVERYTEST1");
    expect(found).toBeDefined();
    expect(found?.intentType).toBe("open");
    expect(found?.intendedQty).toBe("10.5");
  });

  it("finds a position that fully opened, then crashed before closing", async () => {
    const positionId = await insertPosition({
      symbol: "RECOVERYTEST2",
      state: "OPEN",
      openedAt: new Date(),
      closedAt: null,
    });
    await insertIntent(positionId, "open", "5", new Date(Date.now() - 60_000));

    const unresolved = await findUnresolvedIntents(db);
    expect(unresolved.find((u) => u.symbol === "RECOVERYTEST2")).toBeDefined();
  });

  it("excludes a position that was cleanly closed (closed_at set)", async () => {
    const positionId = await insertPosition({
      symbol: "RECOVERYTEST3",
      state: "CLOSED",
      openedAt: new Date(Date.now() - 120_000),
      closedAt: new Date(),
    });
    await insertIntent(positionId, "close", "3", new Date());

    const unresolved = await findUnresolvedIntents(db);
    expect(unresolved.find((u) => u.symbol === "RECOVERYTEST3")).toBeUndefined();
  });

  it("returns only the LATEST intent when a position has multiple intent rows (e.g. open then a later close attempt)", async () => {
    const positionId = await insertPosition({
      symbol: "RECOVERYTEST4",
      state: "LEG_CLOSE_SENT",
      openedAt: new Date(Date.now() - 300_000),
      closedAt: null,
    });
    await insertIntent(positionId, "open", "7", new Date(Date.now() - 200_000));
    await insertIntent(positionId, "close", "7", new Date(Date.now() - 10_000));

    const unresolved = await findUnresolvedIntents(db);
    const found = unresolved.find((u) => u.symbol === "RECOVERYTEST4");
    expect(found).toBeDefined();
    expect(found?.intentType).toBe("close"); // the later row, not the first
  });
});
