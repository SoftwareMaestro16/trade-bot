-- Up Migration
--
-- Owner request: a failed Telegram send (digest or any future alert type)
-- must not simply vanish. Before this table, `scheduleDailyAt`'s own generic
-- catch (src/notify/dailySchedule.ts) logs the failure and moves on — the
-- specific message (e.g. "here's what happened these last 12 hours") is
-- gone forever even though the underlying data it summarized is fine. This
-- table is a small persistent outbox: a message that fails to send is
-- queued here, and gets a real retry both periodically and — critically —
-- at the next process startup, so a message that failed because the WHOLE
-- PROCESS was down (network outage, crash, deploy) still gets delivered
-- once it's back, not just messages that failed for some in-process reason
-- while already running.
--
-- Deliberately generic (not digest-specific): `notify/telegram.ts`'s
-- `sendAlert` takes arbitrary text + parseMode, and the owner's own request
-- notes "но там же не только это должно приходить" (this isn't only about
-- the digest) — killswitch alerts, future notification types, all route
-- through the same queue rather than each growing its own bespoke retry
-- logic.
CREATE TABLE pending_telegram_messages (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The exact message body, already formatted (HTML entities escaped etc.) —
  -- this table stores what sendAlert would have been called with, not a
  -- template to re-render later. Re-rendering at delivery time would risk
  -- the delivered message no longer matching the moment it describes (e.g.
  -- a digest's own window-relative wording).
  message_text text NOT NULL,
  parse_mode text, -- 'HTML' or NULL, mirrors SendAlertOptions.parseMode
  delivered_at timestamptz, -- NULL until a retry succeeds
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text
);

-- The only real read pattern: "give me everything not yet delivered, oldest
-- first" — retried in the order they were queued, not newest-first, so a
-- long backlog drains in the order it accumulated rather than perpetually
-- prioritizing the newest failure over an older one.
CREATE INDEX pending_telegram_messages_undelivered_idx
  ON pending_telegram_messages (created_at)
  WHERE delivered_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS pending_telegram_messages;
