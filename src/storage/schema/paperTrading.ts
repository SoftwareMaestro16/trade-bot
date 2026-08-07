import type { ColumnType, Generated } from "kysely";

// Split out of ../schema.ts (now a barrel) — see that file's top comment for
// the full ADR-004/NFR-01 money-as-string / bigint-as-string conventions these
// tables follow, and for the list of migrations/*.sql files this module mirrors.

// ---------------------------------------------------------------------------
// migrations/1786044239655_create-paper-trading-tables.sql (Фаза 2 эмуляция)
// + migrations/1786055157851_add-paper-positions-exit-reasoning.sql (adds
// paper_positions.exit_reasoning, symmetric to entry_reasoning below).
// Deliberately separate paper_*-tables, not an `is_virtual` flag on
// positions/orders/fills above — see that migration's own docstring: those
// real tables fix `order_link_id`/`exec_id` as NOT NULL UNIQUE specifically
// for exchange idempotency (RR-11/RSK-46), a guarantee that has no meaning
// for a simulated fill and that a shared-table flag would either weaken or
// have to fake. Column conventions (numeric -> string, own-clock timestamps
// -> Date, not bigint-ms — paper data has no real exchange timestamp to
// preserve) match the rest of this file.
// (split note: "positions/orders/fills above" now live in ../schema/execution.ts.)
// ---------------------------------------------------------------------------

export interface PaperScenariosTable {
  id: Generated<bigint>;
  name: string;
  leverage: string; // numeric
  starting_deposit: ColumnType<string, string | undefined, string>; // numeric, DB DEFAULT '500'
  // Not stabilized — same reasoning as positions.state/orders.status above,
  // and doubly so here: which literal values this takes is exactly the open
  // question in "pairIntentState.ts reuse vs новая paperPositionState.ts".
  status: string;
  started_at: Date | null;
  stopped_at: Date | null;
}

export interface PaperPositionsTable {
  id: Generated<bigint>;
  scenario_id: bigint; // FK paper_scenarios.id
  symbol: string;
  state: string; // not stabilized — mirrors positions.state above
  spot_qty: string | null; // numeric — unknown at intent time, same as positions.spot_qty
  perp_qty: string | null; // numeric — unknown at intent time
  leverage: string; // numeric — fixed at position open, unlike spot_qty/perp_qty
  entry_reasoning: string | null; // FR-202: rationale, not a fact
  opened_at: Date | null;
  closed_at: Date | null;
  // Known only once the position closes (scenarioRunner.ts closePosition) — null
  // until then, same reasoning as spot_qty/perp_qty above. Positive cost
  // magnitude, same sign convention as paper_fills.fee — not pre-negated.
  slippage_cost: string | null; // numeric
  borrow_cost: string | null; // numeric
  // migrations/1786055157851_add-paper-positions-exit-reasoning.sql: symmetric
  // to entry_reasoning above — rationale for the CLOSE decision (reasonCode,
  // funding/basis at exit, hold duration, forced-liquidation price if
  // applicable — see scenarioRunner.ts closePosition), not a fact. Null until
  // the position closes, same reasoning as slippage_cost/borrow_cost above.
  exit_reasoning: string | null; // FR-202
}

export interface PaperFillsTable {
  id: Generated<bigint>;
  position_id: bigint; // FK paper_positions.id
  leg: "spot" | "perp";
  side: string;
  qty: string; // numeric
  price: string; // numeric
  fee: string; // numeric
  executed_at: Date;
}

export interface PaperFundingPaymentsTable {
  id: Generated<bigint>;
  position_id: bigint; // FK paper_positions.id
  amount: string; // numeric
  rate: string; // numeric
  interval_minutes: number;
  paid_at: Date;
}

export interface PaperEquitySnapshotsTable {
  id: Generated<bigint>;
  scenario_id: bigint; // FK paper_scenarios.id
  // Append-only, same as real EquitySnapshotsTable.at — never updated after insert.
  at: ColumnType<Date, Date | undefined, never>;
  total_equity: string; // numeric
  margin_balance: string; // numeric
  is_peak: Generated<boolean>; // DEFAULT false
}
