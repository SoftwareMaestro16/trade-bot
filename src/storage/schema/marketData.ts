import type { ColumnType, Generated } from "kysely";

// Split out of ../schema.ts (now a barrel) — see that file's top comment for
// the full ADR-004/NFR-01 money-as-string / bigint-as-string conventions these
// tables follow, and for the list of migrations/*.sql files this module mirrors.

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
