import type { ColumnType, Generated } from "kysely";

// Split out of ../schema.ts (now a barrel) — see that file's top comment for
// the full ADR-004/NFR-01 money-as-string / bigint-as-string conventions these
// tables follow, and for the list of migrations/*.sql files this module mirrors.

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
