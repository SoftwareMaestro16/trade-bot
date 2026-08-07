import type { ColumnType, Generated, JSONColumnType } from "kysely";

// Split out of ../schema.ts (now a barrel) — see that file's top comment for
// the full ADR-004/NFR-01 money-as-string / bigint-as-string conventions these
// tables follow, and for the list of migrations/*.sql files this module mirrors.

// ---------------------------------------------------------------------------
// migrations/1785974753672_create-position-tables.sql (Фаза 2+: state machine,
// intents, orders, fills, funding payments, risk vetoes, equity snapshots).
// ARCHITECTURE.md §3 (schema sketch) / §4 (position state machine).
//
// Money/rate/qty columns (qty, price, fee, amount, rate, *_equity, *_value) are
// `string` for the same OID-1700-has-no-parser reason as the market-data tables
// above. `id` PK columns use `Generated<bigint>`, matching every bigserial PK in
// this file. FK columns that point at one of those PKs (orders.position_id,
// position_intents.position_id, fills.order_id, funding_payments.position_id)
// are typed plain `bigint`/`bigint | null` to match, so `.where('position_id',
// '=', someRow.id)` type-checks without a cast — unlike the exchange-timestamp
// bigint columns above (funding_timestamp_ms etc.), which are `string` because
// they're wire values, not join keys.
// (split note: "the market-data tables above" now live in ../schema/marketData.ts.)
// ---------------------------------------------------------------------------

/**
 * NFR-03: jsonb columns must never carry a number — the driver parses jsonb via
 * JSON.parse, turning any number into a lossy float, exactly the bug ADR-003
 * exists to prevent for every money/qty column elsewhere in this file. This
 * type excludes `number` structurally, so a stray `{ qty: 5 }` literal in a
 * payload/intent value fails to compile instead of only failing review. Actual
 * money/qty values belong in this table's own `numeric` columns instead
 * (position_intents.intended_qty, risk_vetoes.threshold_value/actual_value).
 */
type NonNumericJson = string | boolean | null | NonNumericJson[] | { [key: string]: NonNumericJson };

export interface PositionsTable {
  id: Generated<bigint>;
  symbol: string;
  // ARCHITECTURE.md §4: the state machine isn't stabilized yet, so this is
  // deliberately left as plain `string`, not a literal union — narrowing it
  // here would re-introduce at the type level exactly what the migration's
  // comment says the CHECK constraint must NOT do yet.
  state: string;
  spot_qty: string | null; // numeric — unknown at intent time
  perp_qty: string | null; // numeric — unknown at intent time
  entry_reasoning: string | null; // FR-202: rationale for the decision, not a fact
  opened_at: Date | null;
  closed_at: Date | null;
  peak_equity_at_open: string | null; // numeric
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface PositionIntentsTable {
  id: Generated<bigint>;
  // FK positions.id, nullable: on first entry the intent is written (RR-12)
  // before the position row exists.
  position_id: bigint | null;
  intent_type: string; // 'open' | 'close' | 'unwind_leg' — see migration comment
  // NFR-03: no money/qty inside this JSON — see intended_qty below.
  payload: JSONColumnType<Record<string, NonNumericJson>>;
  intended_qty: string | null; // numeric
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface OrdersTable {
  id: Generated<bigint>;
  position_id: bigint | null; // FK positions.id
  leg: "spot" | "perp";
  side: string; // exchange order side, as sent to/reported by Bybit
  order_link_id: string; // RR-11: idempotency key, UNIQUE
  intended_qty: string; // numeric
  // ARCHITECTURE.md §4: 'intent'|'sent'|'acked'|'filled'|'partial'|'failed'|'unknown'.
  // Plain `string`, not a literal union — same reasoning as positions.state:
  // not stabilized yet, not fixed here either.
  status: string;
  exchange_order_id: string | null;
  sent_at: Date | null;
  last_checked_at: Date | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface FillsTable {
  id: Generated<bigint>;
  order_id: bigint; // FK orders.id
  qty: string; // numeric
  price: string; // numeric
  fee: string; // numeric
  fee_asset: string;
  executed_at: Date;
  exec_id: string; // RSK-46: dedup key on Bybit's execId, UNIQUE — not bigint-like, it's a string
}

export interface FundingPaymentsTable {
  id: Generated<bigint>;
  position_id: bigint; // FK positions.id
  symbol: string;
  amount: string; // numeric
  rate: string; // numeric
  interval_start_ms: string; // bigint -> string over the wire
  interval_end_ms: string; // bigint -> string over the wire
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface RiskVetoesTable {
  id: Generated<bigint>;
  at: ColumnType<Date, Date | undefined, never>;
  // NFR-03: symbol/context only, no money inside — thresholds/actuals below.
  // Shape mirrors VetoResult (src/risk/types.ts): every risk/ run is logged
  // here, not just denials.
  intent: JSONColumnType<Record<string, NonNumericJson>>;
  veto_code: string | null; // null = passed; NOT NULL = e.g. 'LEVERAGE_EXCEEDED'
  veto_reason: string | null;
  threshold_value: string | null; // numeric
  actual_value: string | null; // numeric
}

export interface EquitySnapshotsTable {
  id: Generated<bigint>;
  at: ColumnType<Date, Date | undefined, never>;
  total_equity: string; // numeric
  margin_balance: string; // numeric
  is_peak: Generated<boolean>; // DEFAULT false
}
