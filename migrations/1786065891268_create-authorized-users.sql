-- Up Migration
--
-- RR-33 (SRS.md) originally allowed exactly one Telegram chat_id
-- (TelegramConfig.allowedChatId, from .env) to issue kill-switch commands.
-- Owner's own request: let that single "root admin" chat_id grant additional
-- trusted chat_ids the same command access via /add and /delete, without
-- widening the whitelist to "anyone" and without moving the root admin
-- itself into this table (the root admin stays the .env value — see
-- killswitch-listener.ts's isAuthorizedChat, which short-circuits to `true`
-- for the root admin WITHOUT ever touching this table, so a DB outage can
-- never lock the owner out of their own kill switch).
--
-- chat_id is `text`, not `bigint` — same reasoning as every other chat_id
-- comparison in this codebase (see telegram.ts's authorizeCommand doc
-- comment): chat_id is compared as an opaque string, never coerced through
-- Number(), so the storage type must not tempt a numeric comparison either.
-- Real Telegram USER chat_ids are always positive; group/supergroup/channel
-- chat_ids are always negative — that fact is enforced at the application
-- layer (killswitch-listener.ts's /add validation), not by a CHECK
-- constraint here, since "looks like a real user id" is a format/length
-- heuristic, not something a DB constraint should encode.
--
-- added_by/added_at are an audit trail only (who ran /add, and when) — no
-- code branches on their value today.
CREATE TABLE authorized_users (
  chat_id text PRIMARY KEY,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS authorized_users;
