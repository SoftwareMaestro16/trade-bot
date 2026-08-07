import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import {
  addAuthorizedUser,
  isAuthorizedChat,
  isPlausibleUserChatId,
  manageAuthorizedUserCommand,
  removeAuthorizedUser,
} from "../../src/killswitch/authorizedUsers.js";
import type { Database } from "../../src/storage/schema.js";

// Arbitrary stand-ins, distinct from each other and from any real chat_id —
// only used to exercise "root admin" vs "authorized_users row" behavior.
const ROOT_ADMIN_CHAT_ID = "555000111";
const TEST_CHAT_ID = "700111222";

// A pool pointed at a port nothing listens on: any real query against it
// rejects (connection refused) — used by the tests below that need to prove
// isAuthorizedChat behaves correctly WITHOUT a working database, without
// actually waiting out a real network timeout against an unreachable host.
function brokenDb(): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: "postgresql://nouser:nopass@127.0.0.1:1/nonexistent" });
  pool.on("error", () => {
    // Same reasoning as storage/db.ts's pool 'error' handler: zero listeners
    // on a background pool error is an uncaught exception in Node. This pool
    // is deliberately never going to connect successfully, so a listener
    // that does nothing is the correct (and only sane) response here.
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

describe("killswitch/authorizedUsers (RR-33 extension, against a real local Postgres)", () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run `docker compose up -d` and ensure .env has DATABASE_URL before running this test.",
      );
    }
    // Same connection pattern as haltStatePersistence.test.ts: a standalone
    // pg.Pool + PostgresDialect, not storage/db.ts's createDb, kept local to
    // this test file.
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", () => {});
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  });

  afterEach(async () => {
    // Belt-and-braces cleanup so a failed assertion mid-test can't leak
    // TEST_CHAT_ID into the next test/run — same reasoning as
    // haltStatePersistence.test.ts's afterEach.
    await db.deleteFrom("authorized_users").where("chat_id", "=", TEST_CHAT_ID).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe("isPlausibleUserChatId", () => {
    it("accepts a positive integer of plausible length, including the 5-digit minimum", () => {
      expect(isPlausibleUserChatId("555000111")).toBe(true);
      expect(isPlausibleUserChatId("12345")).toBe(true);
    });

    it("rejects a negative number — a typical group/supergroup/channel chat_id", () => {
      expect(isPlausibleUserChatId("-1001234567890")).toBe(false);
    });

    it("rejects garbage and too-short input", () => {
      expect(isPlausibleUserChatId("abc")).toBe(false);
      expect(isPlausibleUserChatId("")).toBe(false);
      expect(isPlausibleUserChatId("12")).toBe(false);
    });

    it("rejects a leading zero (not a canonical positive integer)", () => {
      expect(isPlausibleUserChatId("012345")).toBe(false);
    });
  });

  describe("isAuthorizedChat", () => {
    it("returns true for the root admin chat_id WITHOUT touching the database, even if the DB is unreachable", async () => {
      const broken = brokenDb();
      try {
        await expect(isAuthorizedChat(broken, ROOT_ADMIN_CHAT_ID, ROOT_ADMIN_CHAT_ID)).resolves.toBe(true);
      } finally {
        await broken.destroy();
      }
    });

    it("returns false for a chat_id that is neither the root admin nor present in authorized_users", async () => {
      await expect(isAuthorizedChat(db, ROOT_ADMIN_CHAT_ID, "999999999999")).resolves.toBe(false);
    });

    it("returns true for a chat_id present in authorized_users", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);
      await expect(isAuthorizedChat(db, ROOT_ADMIN_CHAT_ID, TEST_CHAT_ID)).resolves.toBe(true);
    });

    it("end-to-end: authorized after /add, no longer authorized after /delete", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);
      await expect(isAuthorizedChat(db, ROOT_ADMIN_CHAT_ID, TEST_CHAT_ID)).resolves.toBe(true);

      await removeAuthorizedUser(db, TEST_CHAT_ID);
      await expect(isAuthorizedChat(db, ROOT_ADMIN_CHAT_ID, TEST_CHAT_ID)).resolves.toBe(false);
    });

    it("fails closed (false, not a thrown error) when the authorized_users lookup itself fails", async () => {
      const broken = brokenDb();
      try {
        // Not the root admin, so this MUST reach the (unreachable) database.
        await expect(isAuthorizedChat(broken, ROOT_ADMIN_CHAT_ID, TEST_CHAT_ID)).resolves.toBe(false);
      } finally {
        await broken.destroy();
      }
    });
  });

  describe("addAuthorizedUser", () => {
    it("inserts a row with the given chat_id and added_by", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);

      const row = await db
        .selectFrom("authorized_users")
        .select(["chat_id", "added_by"])
        .where("chat_id", "=", TEST_CHAT_ID)
        .executeTakeFirst();
      expect(row).toEqual({ chat_id: TEST_CHAT_ID, added_by: ROOT_ADMIN_CHAT_ID });
    });

    it("is idempotent — adding the same chat_id twice neither throws nor duplicates the row", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);
      await expect(addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID)).resolves.toBeUndefined();

      const rows = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", TEST_CHAT_ID)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  describe("removeAuthorizedUser", () => {
    it("deletes an existing row and reports true", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);
      await expect(removeAuthorizedUser(db, TEST_CHAT_ID)).resolves.toBe(true);

      const row = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", TEST_CHAT_ID)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("does not throw when deleting a chat_id that was never added, and reports false", async () => {
      await expect(removeAuthorizedUser(db, "999888777")).resolves.toBe(false);
    });
  });

  describe("manageAuthorizedUserCommand", () => {
    // A chat_id that is itself already authorized (present in
    // authorized_users) but NOT the root admin — the case the owner's
    // requirement is specifically about: an authorized-but-not-root sender
    // must not be able to manage the list.
    const NON_ROOT_AUTHORIZED_CHAT_ID = "800111222";

    it("/add from a non-root-admin sender adds nothing to the table", async () => {
      const result = await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: NON_ROOT_AUTHORIZED_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });

      expect(result).toEqual({ outcome: "rejected_not_root_admin" });
      const row = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", TEST_CHAT_ID)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("/delete from a non-root-admin sender removes nothing from the table", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);

      const result = await manageAuthorizedUserCommand(db, {
        command: "delete",
        senderChatId: NON_ROOT_AUTHORIZED_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });

      expect(result).toEqual({ outcome: "rejected_not_root_admin" });
      const row = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", TEST_CHAT_ID)
        .executeTakeFirst();
      expect(row).toEqual({ chat_id: TEST_CHAT_ID });
    });

    it("/add from the root admin adds the chat_id, with added_by = root admin", async () => {
      const result = await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });

      expect(result).toEqual({ outcome: "added", chatId: TEST_CHAT_ID });
      const row = await db
        .selectFrom("authorized_users")
        .select(["chat_id", "added_by"])
        .where("chat_id", "=", TEST_CHAT_ID)
        .executeTakeFirst();
      expect(row).toEqual({ chat_id: TEST_CHAT_ID, added_by: ROOT_ADMIN_CHAT_ID });
    });

    it("a repeated /add from the root admin on the same chat_id does not fail or duplicate the row", async () => {
      const first = await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });
      const second = await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });

      expect(first).toEqual({ outcome: "added", chatId: TEST_CHAT_ID });
      expect(second).toEqual({ outcome: "added", chatId: TEST_CHAT_ID });
      const rows = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", TEST_CHAT_ID)
        .execute();
      expect(rows).toHaveLength(1);
    });

    it("/delete from the root admin removes an existing chat_id", async () => {
      await addAuthorizedUser(db, TEST_CHAT_ID, ROOT_ADMIN_CHAT_ID);

      const result = await manageAuthorizedUserCommand(db, {
        command: "delete",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });

      expect(result).toEqual({ outcome: "removed", chatId: TEST_CHAT_ID, wasPresent: true });
      const row = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", TEST_CHAT_ID)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("/delete from the root admin on a chat_id that was never added does not throw", async () => {
      const result = await manageAuthorizedUserCommand(db, {
        command: "delete",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });

      expect(result).toEqual({ outcome: "removed", chatId: TEST_CHAT_ID, wasPresent: false });
    });

    it("rejects a group/channel-shaped (negative) candidate from the root admin without touching the table", async () => {
      const result = await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: "-1001234567890",
      });

      expect(result).toEqual({ outcome: "rejected_invalid_candidate", candidate: "-1001234567890" });
      const row = await db
        .selectFrom("authorized_users")
        .select("chat_id")
        .where("chat_id", "=", "-1001234567890")
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("rejects a missing candidate (e.g. bare '/add' with no argument) from the root admin", async () => {
      const result = await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: undefined,
      });

      expect(result).toEqual({ outcome: "rejected_invalid_candidate", candidate: undefined });
    });

    it("end-to-end: /add then isAuthorizedChat sees it, /delete then isAuthorizedChat no longer sees it", async () => {
      await manageAuthorizedUserCommand(db, {
        command: "add",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });
      await expect(isAuthorizedChat(db, ROOT_ADMIN_CHAT_ID, TEST_CHAT_ID)).resolves.toBe(true);

      await manageAuthorizedUserCommand(db, {
        command: "delete",
        senderChatId: ROOT_ADMIN_CHAT_ID,
        rootAdminChatId: ROOT_ADMIN_CHAT_ID,
        candidate: TEST_CHAT_ID,
      });
      await expect(isAuthorizedChat(db, ROOT_ADMIN_CHAT_ID, TEST_CHAT_ID)).resolves.toBe(false);
    });
  });
});
