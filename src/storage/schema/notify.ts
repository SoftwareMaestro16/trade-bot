import type { ColumnType, Generated } from "kysely";

// Split out of ../schema.ts (now a barrel) — see that file's top comment for
// the full ADR-004/NFR-01 money-as-string / bigint-as-string conventions these
// tables follow, and for the list of migrations/*.sql files this module mirrors.

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
