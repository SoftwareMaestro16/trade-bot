import type { ColumnType, Generated, JSONColumnType } from "kysely";

/**
 * Mirrors, table-for-table, every migration under migrations/ that declares a
 * table this bot reads/writes through Kysely:
 *  - 1785958682080_create-market-data-tables.sql (Фаза 1: tickers, funding_rates, ...)
 *  - 1785974753672_create-position-tables.sql (Фаза 2+: positions, orders, fills, ...)
 *  - 1785974874546_create-halt-state-table.sql (halt_state)
 *  - 1786029586940_create-pending-telegram-messages.sql (pending_telegram_messages)
 *  - 1786044239655_create-paper-trading-tables.sql (paper_* — Фаза 2 эмуляция)
 *
 * ADR-004: Kysely "never touches the runtime types the driver returns" — these
 * types describe the SHAPE, not a promise about the JS runtime type. Money/rate
 * columns are typed `string` here on purpose (NFR-01/ADR-003): `numeric` comes
 * back from `pg` as a string (no registered parser for OID 1700), and treating it
 * as `number` in the type system would silently invite `JSON.parse`-style float
 * bugs at the first careless `+row.rate`. Exchange-timestamp `bigint` columns
 * (`*_ms`) are `string` for the same reason (OID 20/int8 has no parser either).
 */

type CollectionRunStatus = "running" | "completed" | "failed";

export interface CollectionRunsTable {
  id: Generated<bigint>;
  started_at: ColumnType<Date, Date | undefined, never>;
  // Nullable in the DB (migration: `finished_at timestamptz`, no NOT NULL) —
  // stays NULL for the entire lifetime of a row with status='running',
  // including one orphaned by a crash before the closing UPDATE ever runs.
  // The SELECT type must say so: `Date` (non-null) here would let
  // `row.finished_at.getTime()` compile clean and throw at runtime on the
  // first in-progress or orphaned row, with zero warning from the type
  // checker either way — exactly the class of bug ADR-003/NFR-01 exists to
  // prevent for money columns, just showing up on a timestamp instead.
  finished_at: ColumnType<Date | null, Date | undefined, Date | undefined>;
  // DB default 'running' — insert may omit it, matching the migration's DEFAULT.
  status: ColumnType<CollectionRunStatus, CollectionRunStatus | undefined, CollectionRunStatus>;
  symbols_expected: number | null;
  symbols_collected: number | null;
  error: string | null;
}

export interface FundingRatesTable {
  symbol: string;
  kind: "settled" | "predicted";
  rate: string; // numeric
  interval_minutes: number;
  funding_timestamp_ms: string; // bigint -> string over the wire
  fetched_at: ColumnType<Date, Date | undefined, never>;
}

export interface TickersTable {
  symbol: string;
  category: "linear" | "spot";
  last_price: string; // numeric
  mark_price: string | null; // numeric
  index_price: string | null; // numeric
  volume_24h: string | null; // numeric
  turnover_24h: string | null; // numeric
  fetched_at: ColumnType<Date, Date | undefined, never>;
}

export interface OpenInterestTable {
  symbol: string;
  open_interest: string; // numeric
  data_period: string;
  data_timestamp_ms: string; // bigint
  fetched_at: ColumnType<Date, Date | undefined, never>;
}

export interface LongShortRatioTable {
  symbol: string;
  buy_ratio: string; // numeric
  sell_ratio: string; // numeric
  data_period: string;
  data_timestamp_ms: string; // bigint
  fetched_at: ColumnType<Date, Date | undefined, never>;
}

export interface LiquidationsTable {
  symbol: string;
  side: "Buy" | "Sell";
  size: string; // numeric
  price: string; // numeric
  liquidation_time_ms: string; // bigint
  received_at: ColumnType<Date, Date | undefined, never>;
}

export interface OrderbookLevelsTable {
  symbol: string;
  category: "linear" | "spot";
  side: "bid" | "ask";
  level_index: number;
  price: string; // numeric
  qty: string; // numeric
  fetched_at: ColumnType<Date, Date | undefined, never>;
}

// Mirrors migrations/1786029586940_create-pending-telegram-messages.sql.
export interface PendingTelegramMessagesTable {
  id: Generated<bigint>;
  created_at: ColumnType<Date, Date | undefined, never>;
  message_text: string;
  parse_mode: string | null;
  delivered_at: ColumnType<Date | null, Date | undefined, Date | undefined>;
  attempts: ColumnType<number, number | undefined, number>;
  last_attempt_at: ColumnType<Date | null, Date | undefined, Date | undefined>;
  last_error: string | null;
}

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

// ---------------------------------------------------------------------------
// migrations/1785974874546_create-halt-state-table.sql (RISK-REGISTER.md FM-34).
// Singleton table (CHECK id = 1): exactly one row, inserted by the migration
// itself and never inserted again by application code — see the migration's
// own comment for why "last row by timestamp" was rejected in favor of this.
// ---------------------------------------------------------------------------

export interface HaltStateTable {
  // `integer` (not bigserial) with DEFAULT 1 — `Generated<number>` describes
  // that DB-side default faithfully; the app never actually inserts a row
  // (loadHaltState/saveHaltState only SELECT/UPDATE WHERE id = 1).
  id: Generated<number>;
  halt_new: Generated<boolean>; // DEFAULT false
  flatten_all: Generated<boolean>; // DEFAULT false
  reason: string | null;
  set_by: string | null;
  set_at_ms: string | null; // bigint -> string over the wire, same as elsewhere in this file
  // DEFAULT now() fires only on the migration's own INSERT — Postgres does not
  // re-run a column DEFAULT on UPDATE (it's not a trigger), so every runtime
  // save must supply this explicitly. Update type is therefore `Date | undefined`,
  // not `never` (contrast the append-only `created_at`/`at` columns above,
  // which genuinely are never updated after insert).
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>;
}

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

// ---------------------------------------------------------------------------
// migrations/1786065891268_create-authorized-users.sql — additional Telegram
// chat_ids the root admin (TelegramConfig.allowedChatId / env.TELEGRAM_CHAT_ID,
// unchanged) has granted kill-switch command access to via /add. chat_id is
// `text`, compared as an opaque string, same reasoning as everywhere else in
// this file that touches a Telegram chat_id (see telegram.ts's
// authorizeCommand doc comment) — never coerce through Number().
// ---------------------------------------------------------------------------

export interface AuthorizedUsersTable {
  chat_id: string;
  added_by: string;
  added_at: ColumnType<Date, Date | undefined, never>;
}

export interface Database {
  collection_runs: CollectionRunsTable;
  funding_rates: FundingRatesTable;
  tickers: TickersTable;
  open_interest: OpenInterestTable;
  long_short_ratio: LongShortRatioTable;
  liquidations: LiquidationsTable;
  orderbook_levels: OrderbookLevelsTable;
  pending_telegram_messages: PendingTelegramMessagesTable;
  positions: PositionsTable;
  position_intents: PositionIntentsTable;
  orders: OrdersTable;
  fills: FillsTable;
  funding_payments: FundingPaymentsTable;
  risk_vetoes: RiskVetoesTable;
  equity_snapshots: EquitySnapshotsTable;
  halt_state: HaltStateTable;
  paper_scenarios: PaperScenariosTable;
  paper_positions: PaperPositionsTable;
  paper_fills: PaperFillsTable;
  paper_funding_payments: PaperFundingPaymentsTable;
  paper_equity_snapshots: PaperEquitySnapshotsTable;
  authorized_users: AuthorizedUsersTable;
}
