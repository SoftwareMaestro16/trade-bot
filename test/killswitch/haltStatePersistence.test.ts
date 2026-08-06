import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { applyFlattenAll, applyHaltNew, CLEARED_STATE } from "../../src/killswitch/haltState.js";
import type { HaltState } from "../../src/killswitch/haltState.js";
import { loadHaltState, saveHaltState } from "../../src/killswitch/haltStatePersistence.js";
import type { HaltStateDatabase } from "../../src/killswitch/haltStatePersistence.js";

describe("killswitch/haltStatePersistence (RISK-REGISTER.md FM-34, against a real local Postgres)", () => {
  let db: Kysely<HaltStateDatabase>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run `docker compose up -d` and ensure .env has DATABASE_URL before running this test.",
      );
    }
    // Deliberately not storage/db.ts's createDb: that returns Kysely<Database> from
    // the app-wide schema, which does not (and, per today's scope, should not) know
    // about halt_state. Same connection pattern (pg.Pool + PostgresDialect), scoped
    // to the narrow HaltStateDatabase this module actually needs.
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    db = new Kysely<HaltStateDatabase>({ dialect: new PostgresDialect({ pool }) });
  });

  afterEach(async () => {
    // The table is a migration-created singleton row, shared across every test in
    // this file (and any future run against the same database) — leave it at
    // CLEARED_STATE so the next test/run finds it in the same state a fresh
    // migration would produce.
    await saveHaltState(db, CLEARED_STATE);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("loadHaltState right after migration returns a state equivalent to CLEARED_STATE", async () => {
    const state = await loadHaltState(db);
    expect(state).toEqual(CLEARED_STATE);
  });

  it("round-trips applyHaltNew's state through save/load, including exact setAtMs", async () => {
    const nowMs = Date.now();
    const halted = applyHaltNew(CLEARED_STATE, "manual pause", "manual", nowMs);

    await saveHaltState(db, halted);
    const loaded = await loadHaltState(db);

    expect(loaded).toEqual(halted);
    // Exact equality, not just toEqual above — a bigint->string->number precision
    // loss would still pass toEqual if it happened to round nowMs to itself, so this
    // pins down the specific property the persistence layer must not corrupt.
    expect(loaded.setAtMs).toBe(nowMs);
  });

  it("round-trips applyFlattenAll's state through save/load, with both flags true", async () => {
    const nowMs = Date.now();
    const flattened = applyFlattenAll(CLEARED_STATE, "drawdown breach", "risk:DRAWDOWN_EXCEEDED", nowMs);

    await saveHaltState(db, flattened);
    const loaded = await loadHaltState(db);

    expect(loaded).toEqual(flattened);
    expect(loaded.haltNew).toBe(true);
    expect(loaded.flattenAll).toBe(true);
  });

  it("round-trips a state with null reason/setBy without turning them into empty strings", async () => {
    // Not producible by applyHaltNew/applyFlattenAll (both require non-empty
    // reason/setBy) — constructed directly to test the persistence layer's null
    // handling independent of haltState.ts's own construction rules, and to keep
    // this test meaningfully different from the CLEARED_STATE case above (which
    // also has null reason/setBy, but with both flags false).
    const state: HaltState = { haltNew: true, flattenAll: false, reason: null, setBy: null, setAtMs: null };

    await saveHaltState(db, state);
    const loaded = await loadHaltState(db);

    expect(loaded.reason).toBeNull();
    expect(loaded.setBy).toBeNull();
    expect(loaded).toEqual(state);
  });
});
