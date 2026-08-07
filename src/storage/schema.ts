import type {
  CollectionRunsTable,
  FundingRatesTable,
  LiquidationsTable,
  LongShortRatioTable,
  OpenInterestTable,
  OrderbookLevelsTable,
  TickersTable,
} from "./schema/marketData.js";
import type { PendingTelegramMessagesTable } from "./schema/notify.js";
import type {
  EquitySnapshotsTable,
  FillsTable,
  FundingPaymentsTable,
  OrdersTable,
  PositionIntentsTable,
  PositionsTable,
  RiskVetoesTable,
} from "./schema/execution.js";
import type { AuthorizedUsersTable, HaltStateTable } from "./schema/killswitchAndAuth.js";
import type {
  PaperEquitySnapshotsTable,
  PaperFillsTable,
  PaperFundingPaymentsTable,
  PaperPositionsTable,
  PaperScenariosTable,
} from "./schema/paperTrading.js";

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
 *
 * This file is now a barrel: the table interfaces themselves live under
 * ./schema/ (marketData.ts, notify.ts, execution.ts, killswitchAndAuth.ts,
 * paperTrading.ts), grouped the same way migrations/ and src/ already group
 * these domains. Every interface below is re-exported unchanged, so existing
 * `from ".../storage/schema.js"` imports keep working without modification.
 */

export * from "./schema/marketData.js";
export * from "./schema/notify.js";
export * from "./schema/execution.js";
export * from "./schema/killswitchAndAuth.js";
export * from "./schema/paperTrading.js";

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
