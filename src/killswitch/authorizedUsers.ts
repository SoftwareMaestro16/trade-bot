import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ module: "killswitch:authorizedUsers" });

/**
 * RR-33 (SRS.md) originally allowed exactly one Telegram chat_id — the "root
 * admin", `TelegramConfig.allowedChatId` / `env.TELEGRAM_CHAT_ID` — to issue
 * kill-switch commands. This module is the DB half of extending that to
 * "root admin + a table of additionally authorized chat_ids the root admin
 * has granted access to via /add" (killswitch-listener.ts's /add and
 * /delete handlers). Mirrors this project's existing split between pure/DB
 * logic (haltState.ts/haltStatePersistence.ts) and orchestration
 * (killswitch-listener.ts): this file owns the `authorized_users` table
 * (migrations/1786065891268_create-authorized-users.sql) and nothing else —
 * it does not know about Telegram commands, /add parsing, or which chat_id
 * is root admin beyond the value it's handed as a parameter.
 */

/**
 * Real Telegram USER chat_ids are always positive; group/supergroup/channel
 * chat_ids are always negative (see notify/telegram.ts's authorizeCommand
 * doc comment — this fact is already relied on there). This pattern accepts
 * a positive integer, no leading zero, 5-15 digits total: long enough to
 * reject a short/garbage candidate like "12" or "abc", and — because it
 * requires the FIRST character to be `[1-9]` — a leading "-" (any
 * group/supergroup/channel id, e.g. "-1001234567890") can never match. This
 * is a plausibility check only, not proof the id exists on Telegram's side —
 * there is no cheap way to verify that without messaging it.
 */
const PLAUSIBLE_USER_CHAT_ID_PATTERN = /^[1-9]\d{4,14}$/;

export function isPlausibleUserChatId(candidate: string): boolean {
  return PLAUSIBLE_USER_CHAT_ID_PATTERN.test(candidate);
}

/**
 * Answers "is this chat_id allowed to issue kill-switch commands?" for the
 * `ChatAuthorizer` shape `notify/telegram.ts`'s `authorizeCommand` expects.
 *
 * The root-admin check happens FIRST and returns `true` immediately, with NO
 * database access — deliberately, so a DB outage can never lock the owner
 * out of their own kill switch (same resilience posture as the rest of this
 * process: RISK-REGISTER.md FM-34's whole point is a stop mechanism that
 * keeps working when other things are breaking). Only a chat_id that is NOT
 * the root admin ever reaches the `authorized_users` lookup below.
 *
 * The DB query is wrapped in try/catch and FAILS CLOSED: any error (network,
 * pool exhaustion, table missing, ...) is logged and treated as "not
 * authorized", never as "authorized". This is a security-relevant choice,
 * not an incidental one — the alternative (fail open on a DB error) would
 * turn a database hiccup into an authorization bypass.
 */
export async function isAuthorizedChat(
  db: Kysely<Database>,
  rootAdminChatId: string,
  chatId: string,
): Promise<boolean> {
  if (chatId === rootAdminChatId) {
    return true;
  }

  try {
    const row = await db
      .selectFrom("authorized_users")
      .select("chat_id")
      .where("chat_id", "=", chatId)
      .executeTakeFirst();
    return row !== undefined;
  } catch (e) {
    logger.error(
      { err: e, chatId },
      "authorized_users lookup failed — failing closed, treating chat_id as NOT authorized",
    );
    return false;
  }
}

/**
 * Idempotent: `ON CONFLICT (chat_id) DO NOTHING` means adding an already-
 * authorized chat_id is a no-op, not an error — mirrors the owner's own
 * requirement that a repeated /add on the same chat_id must not fail.
 * `addedBy` is an audit-trail field only (see the migration's own doc
 * comment) — always the root admin's chat_id in practice, since only the
 * root admin is ever allowed to call this (enforced by the caller, not
 * here — this function trusts its caller the same way saveHaltState trusts
 * its caller to have already decided a save should happen).
 */
export async function addAuthorizedUser(db: Kysely<Database>, chatId: string, addedBy: string): Promise<void> {
  await db
    .insertInto("authorized_users")
    .values({ chat_id: chatId, added_by: addedBy })
    .onConflict((oc) => oc.column("chat_id").doNothing())
    .execute();
}

/**
 * Deleting a chat_id that isn't in the table is not an error (same
 * "idempotent, not fussy about prior state" spirit as addAuthorizedUser) —
 * the boolean return tells the caller whether a row actually existed, purely
 * so it can log an accurate outcome, not because the caller needs to branch
 * on it.
 */
export async function removeAuthorizedUser(db: Kysely<Database>, chatId: string): Promise<boolean> {
  const result = await db.deleteFrom("authorized_users").where("chat_id", "=", chatId).executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

export type ManageAuthorizedUserOutcome =
  | { outcome: "rejected_not_root_admin" }
  | { outcome: "rejected_invalid_candidate"; candidate: string | undefined }
  | { outcome: "added"; chatId: string }
  | { outcome: "removed"; chatId: string; wasPresent: boolean }
  | { outcome: "db_error"; error: unknown };

/**
 * Owns the FULL decision for /add and /delete, deliberately including the
 * "is the sender even allowed to run this at all" gate — not just the DB
 * mutation. Owner's own requirement: /add and /delete manage WHO can issue
 * every other kill-switch command, so they must be restricted to ONLY the
 * root admin, never to a chat_id that merely happens to already be
 * authorized (i.e. present in `authorized_users` — see isAuthorizedChat).
 * Keeping that gate here, not in killswitch-listener.ts, is what makes it
 * directly unit-testable against a real Postgres without booting the whole
 * listener process (file-flag self-test, signal handlers, ...) — same
 * motivation as haltState.ts's pure applyHaltNew/applyFlattenAll living
 * outside killswitch-listener.ts's own applyAndPersist wrapper.
 *
 * `senderChatId` is compared to `rootAdminChatId` as a plain string, same
 * "never coerce through Number()" discipline as isAuthorizedChat and
 * notify/telegram.ts's authorizeCommand.
 *
 * Returns a description of what happened rather than logging itself — this
 * function has no logger dependency at all, and stays that way; the caller
 * (killswitch-listener.ts) decides how each outcome is logged, same
 * separation as haltStatePersistence.ts (throws/returns; caller logs).
 */
export async function manageAuthorizedUserCommand(
  db: Kysely<Database>,
  params: {
    command: "add" | "delete";
    senderChatId: string;
    rootAdminChatId: string;
    candidate: string | undefined;
  },
): Promise<ManageAuthorizedUserOutcome> {
  const { command, senderChatId, rootAdminChatId, candidate } = params;

  if (senderChatId !== rootAdminChatId) {
    return { outcome: "rejected_not_root_admin" };
  }

  if (candidate === undefined || !isPlausibleUserChatId(candidate)) {
    return { outcome: "rejected_invalid_candidate", candidate };
  }

  try {
    if (command === "add") {
      await addAuthorizedUser(db, candidate, rootAdminChatId);
      return { outcome: "added", chatId: candidate };
    }
    const wasPresent = await removeAuthorizedUser(db, candidate);
    return { outcome: "removed", chatId: candidate, wasPresent };
  } catch (e) {
    return { outcome: "db_error", error: e };
  }
}
