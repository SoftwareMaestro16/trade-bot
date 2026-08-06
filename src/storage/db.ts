import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

/**
 * ADR-003/NFR-02: `numeric` (OID 1700) has no registered parser in node-postgres —
 * it comes back as a string by construction, which is exactly the property this
 * project depends on for exact decimal arithmetic. `int8`/bigint (OID 20) is the
 * same story. We deliberately do NOT call `pg.types.setTypeParser` anywhere in this
 * codebase: the safety property here is the *absence* of a parser, and the
 * dangerous ones (float4/float8, OID 700/701) are simply never used in the schema
 * (schema.ts has no `number`-typed money/rate column — see its own comment).
 */

export function createDb(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // node-postgres emits 'error' on the pool itself for a background failure on an
  // IDLE client (DB restart, network partition) — separate from a query-level
  // failure, which just rejects that query's own promise and is already handled by
  // each caller. With zero listeners, Node's default EventEmitter behavior turns
  // this into an uncaught exception and kills the whole process (verified: a
  // long-running collector or killswitch-listener process died on a background
  // pool error that had nothing to do with any in-flight query). Logging is the
  // correct response, not a reconnect attempt — pg's pool already recycles the
  // bad client internally on its own.
  pool.on("error", (err) => {
    console.error("[db] background pool error on an idle connection:", err);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
