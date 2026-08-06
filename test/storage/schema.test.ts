import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Selectable } from "kysely";
import type {
  Database,
  EquitySnapshotsTable,
  FillsTable,
  FundingPaymentsTable,
  HaltStateTable,
  OrdersTable,
  PaperEquitySnapshotsTable,
  PaperFillsTable,
  PaperFundingPaymentsTable,
  PaperPositionsTable,
  PaperScenariosTable,
  PositionIntentsTable,
  PositionsTable,
  RiskVetoesTable,
} from "../../src/storage/schema.js";

/**
 * ADR-004/NFR-02: schema.ts's own top comment claims it "mirrors, table-for-table,
 * every migration under migrations/". Backlog #37 Part A folded
 * positions/position_intents/orders/fills/funding_payments/risk_vetoes/
 * equity_snapshots/halt_state into `Database` for the first time, and Part B added
 * the new paper_* tables — all without a live Postgres to check against
 * (test/storage/db.test.ts's own precision proof requires DATABASE_URL, and is
 * deliberately NOT required here). This file is the DB-free half of that mirror
 * proof: it parses each CREATE TABLE block straight out of the migration's own
 * .sql text and asserts the resulting column set matches exactly what schema.ts's
 * corresponding interface declares, so a column renamed/added/dropped on only one
 * side of that mirror fails a test instead of only surfacing against a real
 * database (or worse, in production).
 */

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

const POSITION_TABLES_SQL = readFileSync(
  path.join(migrationsDir, "1785974753672_create-position-tables.sql"),
  "utf8",
);
const HALT_STATE_SQL = readFileSync(path.join(migrationsDir, "1785974874546_create-halt-state-table.sql"), "utf8");
const PAPER_TABLES_SQL = readFileSync(
  path.join(migrationsDir, "1786044239655_create-paper-trading-tables.sql"),
  "utf8",
);

/**
 * Pulls the exact column names a `CREATE TABLE <name> ( ... );` block declares
 * straight from the migration text, rather than trusting a hand-copied list that
 * could silently drift from the file it's meant to describe. Relies on the one
 * formatting rule every migration in this repo follows consistently (verified by
 * eye across all of migrations/*.sql): exactly one column-or-constraint per
 * physical line, and the block's closing line is exactly `);`. A constraint line
 * (PRIMARY KEY/FOREIGN KEY/CHECK/UNIQUE/CONSTRAINT) is told apart from a column
 * definition purely by its leading keyword — this is what lets
 * `position_id bigint REFERENCES positions (id) ON DELETE RESTRICT,` count as the
 * column `position_id` while a standalone `PRIMARY KEY (id, at)` line does not
 * count as a column at all. Trailing inline `-- comments` and multi-line block
 * comments above a column need no special handling: the former sit after the part
 * of the line this function reads, the latter never match the column-line pattern
 * in the first place (a comment line starts with `--`, not an identifier).
 */
function extractColumnNames(sql: string, tableName: string): string[] {
  const lines = sql.split("\n");
  const openLine = `CREATE TABLE ${tableName} (`;
  const startIndex = lines.findIndex((line) => line.trim() === openLine);
  if (startIndex === -1) {
    throw new Error(`"${openLine}" not found in migration text`);
  }

  const constraintKeyword = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK|UNIQUE|CONSTRAINT)\b/i;
  const columnLine = /^([a-z_][a-z0-9_]*)\s+\S/;

  const columns: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break; // unreachable given the loop bound; satisfies noUncheckedIndexedAccess
    const trimmed = line.trim();
    if (trimmed.startsWith(");")) break;
    if (constraintKeyword.test(trimmed)) continue;
    const columnName = columnLine.exec(trimmed)?.[1];
    if (columnName) columns.push(columnName);
  }
  return columns;
}

function sorted(names: string[]): string[] {
  return [...names].sort();
}

describe("storage/schema.ts mirrors migrations/*.sql exactly (structural check, no DB required)", () => {
  it("extractColumnNames handles block comments, inline comments, inline CHECK and REFERENCES correctly (self-check on halt_state)", () => {
    // halt_state's migration deliberately exercises every tricky case the parser
    // must get right: a multi-paragraph block comment ahead of a column, a
    // trailing inline comment after the row's comma, and an inline
    // `CHECK (id = 1)` that must stay part of the `id` column rather than being
    // mistaken for a standalone constraint line.
    expect(sorted(extractColumnNames(HALT_STATE_SQL, "halt_state"))).toEqual(
      sorted(["id", "halt_new", "flatten_all", "reason", "set_by", "set_at_ms", "updated_at"]),
    );
  });

  describe("Part A — position-domain tables (create-position-tables.sql)", () => {
    it("positions", () => {
      const sample: Selectable<PositionsTable> = {
        id: 1n,
        symbol: "BTCUSDT",
        state: "OPEN",
        spot_qty: "1.5",
        perp_qty: "1.5",
        entry_reasoning: "r8h clears floor and K=2.0x round-trip cost",
        opened_at: new Date("2026-01-01T00:00:00Z"),
        closed_at: null,
        peak_equity_at_open: "1000",
        created_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(POSITION_TABLES_SQL, "positions")));
    });

    it("position_intents", () => {
      const sample: Selectable<PositionIntentsTable> = {
        id: 1n,
        position_id: null,
        intent_type: "open",
        payload: { symbol: "BTCUSDT" },
        intended_qty: "1.5",
        created_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(
        sorted(extractColumnNames(POSITION_TABLES_SQL, "position_intents")),
      );
    });

    it("orders", () => {
      const sample: Selectable<OrdersTable> = {
        id: 1n,
        position_id: 1n,
        leg: "spot",
        side: "Buy",
        order_link_id: "abc-123",
        intended_qty: "1.5",
        status: "filled",
        exchange_order_id: "xyz",
        sent_at: new Date("2026-01-01T00:00:00Z"),
        last_checked_at: new Date("2026-01-01T00:00:00Z"),
        created_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(POSITION_TABLES_SQL, "orders")));
    });

    it("fills", () => {
      const sample: Selectable<FillsTable> = {
        id: 1n,
        order_id: 1n,
        qty: "1.5",
        price: "64725.12",
        fee: "0.1",
        fee_asset: "USDT",
        executed_at: new Date("2026-01-01T00:00:00Z"),
        exec_id: "exec-1",
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(POSITION_TABLES_SQL, "fills")));
    });

    it("funding_payments", () => {
      const sample: Selectable<FundingPaymentsTable> = {
        id: 1n,
        position_id: 1n,
        symbol: "BTCUSDT",
        amount: "0.05",
        rate: "0.0002",
        interval_start_ms: "1000",
        interval_end_ms: "2000",
        created_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(
        sorted(extractColumnNames(POSITION_TABLES_SQL, "funding_payments")),
      );
    });

    it("risk_vetoes", () => {
      const sample: Selectable<RiskVetoesTable> = {
        id: 1n,
        at: new Date("2026-01-01T00:00:00Z"),
        intent: { symbol: "BTCUSDT" },
        veto_code: "LEVERAGE_EXCEEDED",
        veto_reason: "1.6x exceeds 1.5x ceiling",
        threshold_value: "1.5",
        actual_value: "1.6",
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(POSITION_TABLES_SQL, "risk_vetoes")));
    });

    it("equity_snapshots", () => {
      const sample: Selectable<EquitySnapshotsTable> = {
        id: 1n,
        at: new Date("2026-01-01T00:00:00Z"),
        total_equity: "1000",
        margin_balance: "1000",
        is_peak: false,
      };
      expect(sorted(Object.keys(sample))).toEqual(
        sorted(extractColumnNames(POSITION_TABLES_SQL, "equity_snapshots")),
      );
    });
  });

  describe("Part A — halt_state (create-halt-state-table.sql)", () => {
    it("halt_state", () => {
      const sample: Selectable<HaltStateTable> = {
        id: 1,
        halt_new: false,
        flatten_all: false,
        reason: null,
        set_by: null,
        set_at_ms: null,
        updated_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(HALT_STATE_SQL, "halt_state")));
    });
  });

  describe("Part B — paper_* tables (create-paper-trading-tables.sql)", () => {
    it("paper_scenarios", () => {
      const sample: Selectable<PaperScenariosTable> = {
        id: 1n,
        name: "1.0x baseline",
        leverage: "1.0",
        starting_deposit: "500",
        status: "running",
        started_at: new Date("2026-01-01T00:00:00Z"),
        stopped_at: null,
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(PAPER_TABLES_SQL, "paper_scenarios")));
    });

    it("paper_positions", () => {
      const sample: Selectable<PaperPositionsTable> = {
        id: 1n,
        scenario_id: 1n,
        symbol: "BTCUSDT",
        state: "OPEN",
        spot_qty: "1.5",
        perp_qty: "1.5",
        leverage: "1.0",
        entry_reasoning: "r8h clears floor and K=2.0x round-trip cost",
        opened_at: new Date("2026-01-01T00:00:00Z"),
        closed_at: null,
        slippage_cost: null,
        borrow_cost: null,
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(PAPER_TABLES_SQL, "paper_positions")));
    });

    it("paper_fills", () => {
      const sample: Selectable<PaperFillsTable> = {
        id: 1n,
        position_id: 1n,
        leg: "spot",
        side: "Buy",
        qty: "1.5",
        price: "64725.12",
        fee: "0.1",
        executed_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(sorted(extractColumnNames(PAPER_TABLES_SQL, "paper_fills")));
    });

    it("paper_funding_payments", () => {
      const sample: Selectable<PaperFundingPaymentsTable> = {
        id: 1n,
        position_id: 1n,
        amount: "0.05",
        rate: "0.0002",
        interval_minutes: 480,
        paid_at: new Date("2026-01-01T00:00:00Z"),
      };
      expect(sorted(Object.keys(sample))).toEqual(
        sorted(extractColumnNames(PAPER_TABLES_SQL, "paper_funding_payments")),
      );
    });

    it("paper_equity_snapshots", () => {
      const sample: Selectable<PaperEquitySnapshotsTable> = {
        id: 1n,
        scenario_id: 1n,
        at: new Date("2026-01-01T00:00:00Z"),
        total_equity: "1000",
        margin_balance: "1000",
        is_peak: false,
      };
      expect(sorted(Object.keys(sample))).toEqual(
        sorted(extractColumnNames(PAPER_TABLES_SQL, "paper_equity_snapshots")),
      );
    });

    it("interval_minutes keeps the same > 0 sanity guard as funding_rates.interval_minutes (RSK-25/FM-04) — a corrupted zero/negative interval must not silently pass", () => {
      const block = PAPER_TABLES_SQL.slice(PAPER_TABLES_SQL.indexOf("CREATE TABLE paper_funding_payments ("));
      expect(block).toMatch(/interval_minutes integer NOT NULL CHECK \(interval_minutes > 0\)/);
    });
  });

  it("Database declares every table this task added, each exactly once", () => {
    // Compile-time-only proof (this repo's convention is to self-review types
    // rather than run a project-wide tsc from inside a single-file task — see
    // CLAUDE.md) that every name below is a real `keyof Database`, plus a real
    // runtime assertion that the list itself has no accidental duplicate.
    function tableName<K extends keyof Database>(name: K): K {
      return name;
    }
    const names = [
      tableName("positions"),
      tableName("position_intents"),
      tableName("orders"),
      tableName("fills"),
      tableName("funding_payments"),
      tableName("risk_vetoes"),
      tableName("equity_snapshots"),
      tableName("halt_state"),
      tableName("paper_scenarios"),
      tableName("paper_positions"),
      tableName("paper_fills"),
      tableName("paper_funding_payments"),
      tableName("paper_equity_snapshots"),
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});
