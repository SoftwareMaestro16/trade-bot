import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  computeStatusReport,
  evaluateOverallHealthy,
  evaluateStaleness,
  formatStatusReport,
  formatStatusReportTable,
} from "../../src/notify/statusReport.js";
import type { StatusReport, TableFreshness } from "../../src/notify/statusReport.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";
import type { HaltState } from "../../src/killswitch/haltState.js";
import type { DiskUsage } from "../../src/notify/diskUsage.js";

const SYM = "__TEST_STATUSREPORT__USDT";
const NOW = new Date("2026-08-06T12:00:00Z");

// evaluateStaleness/evaluateOverallHealthy are pure, tested with constructed
// timestamps only — deliberately NOT dependent on any live table's actual
// contents. A shared local dev Postgres used for `npm test` can legitimately
// already hold real collector.ts data (this happened in this very project
// this session), so asserting "table X has zero/old rows" against it would
// be either false or, worse, destructive if a test tried to force that state
// by deleting real rows. See computeStatusReport's own integration tests
// below for what DOES touch the DB — only the "insert a fresh row, confirm
// it's detected as fresh" direction, which is safe regardless of pollution.

describe("evaluateStaleness", () => {
  it("is stale when there is no data at all", () => {
    expect(evaluateStaleness(null, NOW, 10 * 60_000)).toBe(true);
  });

  it("is not stale exactly at the threshold (strict greater-than)", () => {
    const lastWriteAt = new Date(NOW.getTime() - 10 * 60_000);
    expect(evaluateStaleness(lastWriteAt, NOW, 10 * 60_000)).toBe(false);
  });

  it("is stale one ms past the threshold", () => {
    const lastWriteAt = new Date(NOW.getTime() - 10 * 60_000 - 1);
    expect(evaluateStaleness(lastWriteAt, NOW, 10 * 60_000)).toBe(true);
  });

  it("is not stale for a write that just happened", () => {
    expect(evaluateStaleness(NOW, NOW, 10 * 60_000)).toBe(false);
  });
});

describe("evaluateOverallHealthy", () => {
  const freshTable = (table: string): TableFreshness => ({
    table,
    lastWriteAt: NOW,
    ageMs: 0,
    staleAfterMs: 10 * 60_000,
    isStale: false,
  });
  const staleTable = (table: string): TableFreshness => ({
    table,
    lastWriteAt: null,
    ageMs: null,
    staleAfterMs: 10 * 60_000,
    isStale: true,
  });

  it("healthy when every table is fresh and a collection run happened recently", () => {
    const recentRun = new Date(NOW.getTime() - 5 * 60_000);
    expect(evaluateOverallHealthy([freshTable("tickers"), freshTable("orderbook_levels")], recentRun, NOW)).toBe(
      true,
    );
  });

  it("unhealthy when even one table is stale, despite everything else being fine", () => {
    const recentRun = new Date(NOW.getTime() - 5 * 60_000);
    expect(evaluateOverallHealthy([freshTable("tickers"), staleTable("orderbook_levels")], recentRun, NOW)).toBe(
      false,
    );
  });

  it("unhealthy when there has never been a collection run at all", () => {
    expect(evaluateOverallHealthy([freshTable("tickers")], null, NOW)).toBe(false);
  });

  it("unhealthy when the last collection run is older than the recent-run window", () => {
    const oldRun = new Date(NOW.getTime() - 20 * 60_000); // outside the 15min window
    expect(evaluateOverallHealthy([freshTable("tickers")], oldRun, NOW)).toBe(false);
  });
});

describe("formatStatusReport", () => {
  const baseReport: StatusReport = {
    haltNew: false,
    flattenAll: false,
    haltReason: null,
    tables: [
      { table: "tickers", lastWriteAt: NOW, ageMs: 30_000, staleAfterMs: 10 * 60_000, isStale: false },
      { table: "orderbook_levels", lastWriteAt: null, ageMs: null, staleAfterMs: 10 * 60_000, isStale: true },
    ],
    liquidationsRecentCount: 0,
    collectionRunsRecentCompleted: 5,
    collectionRunsRecentFailed: 1,
    lastCollectionRunAt: NOW,
    overallHealthy: false,
    diskUsage: null,
  };

  it("renders a ✅ header when healthy, ⚠️ when not", () => {
    expect(formatStatusReport({ ...baseReport, overallHealthy: true })).toContain("<b>✅ Статус Фазы 1</b>");
    expect(formatStatusReport({ ...baseReport, overallHealthy: false })).toContain("<b>⚠️ Статус Фазы 1</b>");
  });

  it("marks each table individually — fresh gets ✅, stale gets ⚠️", () => {
    const text = formatStatusReport(baseReport);
    expect(text).toContain("✅ tickers");
    expect(text).toContain("⚠️ orderbook_levels");
  });

  it("always shows liquidations with ℹ️, never as stale, regardless of count", () => {
    const text = formatStatusReport({ ...baseReport, liquidationsRecentCount: 0 });
    expect(text).toContain("ℹ️ liquidations");
    expect(text).not.toContain("⚠️ liquidations");
  });

  it("includes the halt reason only when present, HTML-escaped", () => {
    const withoutReason = formatStatusReport(baseReport);
    expect(withoutReason).not.toContain("Причина:");

    const withReason = formatStatusReport({ ...baseReport, haltReason: "drawdown <5%> & climbing" });
    expect(withReason).toContain("Причина: drawdown &lt;5%&gt; &amp; climbing");
  });

  it("shows kill switch flags", () => {
    const text = formatStatusReport({ ...baseReport, haltNew: true, flattenAll: true });
    expect(text).toContain("HALT_NEW: 🛑 on");
    expect(text).toContain("FLATTEN_ALL: 🛑 on");
  });

  it("renders disk usage as н/д (explicit, not silently omitted) when diskUsage is null", () => {
    const text = formatStatusReport({ ...baseReport, diskUsage: null });
    expect(text).toContain("Диск: н/д");
  });

  it("renders disk usage with ✅ below the warning threshold", () => {
    const diskUsage: DiskUsage = {
      path: "/",
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 50 * 1024 ** 3,
      usedFraction: 0.5,
    };
    const text = formatStatusReport({ ...baseReport, diskUsage });
    expect(text).toContain("✅ Диск: 50% занято, свободно 50.0 GB из 100.0 GB");
  });

  it("renders disk usage with ⚠️ at/above the warning threshold (80%)", () => {
    const diskUsage: DiskUsage = {
      path: "/",
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 20 * 1024 ** 3,
      usedFraction: 0.8,
    };
    const text = formatStatusReport({ ...baseReport, diskUsage });
    expect(text).toContain("⚠️ Диск: 80% занято");
  });
});

describe("formatStatusReportTable (Bot API 10.1 sendRichMessage markdown)", () => {
  const baseReport: StatusReport = {
    haltNew: false,
    flattenAll: false,
    haltReason: null,
    tables: [
      { table: "tickers", lastWriteAt: NOW, ageMs: 30_000, staleAfterMs: 10 * 60_000, isStale: false },
      { table: "orderbook_levels", lastWriteAt: null, ageMs: null, staleAfterMs: 10 * 60_000, isStale: true },
    ],
    liquidationsRecentCount: 442,
    collectionRunsRecentCompleted: 5,
    collectionRunsRecentFailed: 1,
    lastCollectionRunAt: NOW,
    overallHealthy: false,
    diskUsage: null,
  };

  it("produces a GFM-style pipe table with one row per gated table plus a liquidations row", () => {
    const table = formatStatusReportTable(baseReport);
    expect(table).toContain("| Таблица | Статус | Возраст |");
    expect(table).toContain("|---|---|---|");
    expect(table).toContain("| tickers | ✅ |");
    expect(table).toContain("| orderbook_levels | ⚠️ |");
    expect(table).toContain("| liquidations | ℹ️ | 442 за последний час |");
  });

  it("uses a markdown heading and bold, not HTML tags", () => {
    const table = formatStatusReportTable({ ...baseReport, overallHealthy: true });
    expect(table).toContain("# ✅ Статус Фазы 1");
    expect(table).toContain("**Kill switch:**");
    expect(table).not.toContain("<b>");
    expect(table).not.toContain("<code>");
  });

  it("includes the halt reason only when present, markdown-pipe-escaped", () => {
    // Boevoy path: killswitch-listener.ts's /status handler calls this
    // function (not formatStatusReport), so this is the branch that actually
    // ships. Mirrors formatStatusReport's own "escaped" test above — same
    // gap, markdown's own escaping (see escapeMdCell/formatDigest.ts) instead
    // of HTML's, since this string goes into a Bot API 10.1 rich_message
    // markdown body rather than an HTML-parse-mode one.
    const withoutReason = formatStatusReportTable(baseReport);
    expect(withoutReason).not.toContain("Причина:");

    const withReason = formatStatusReportTable({ ...baseReport, haltReason: "drawdown | 5% breach" });
    expect(withReason).toContain("Причина: drawdown \\| 5% breach");
    // Unescaped, a literal `|` here would read to Telegram's parser as a
    // pipe-table cell boundary rather than plain text.
    expect(withReason).not.toContain("Причина: drawdown | 5% breach");
  });

  it("separates every non-table block with a blank line, so Bot API 10.1 doesn't merge them into one run-on paragraph", () => {
    // Confirmed by direct testing against the real API (2026-08-06): a single
    // \n inside one markdown paragraph collapses to a space, and a table
    // needs a blank line before it or it merges into the preceding text as
    // literal `|` characters instead of rendering as a table block.
    const table = formatStatusReportTable(baseReport);
    const tableBlockStart = table.indexOf("| Таблица");
    expect(table.slice(tableBlockStart - 2, tableBlockStart)).toBe("\n\n");
  });

  it("renders disk usage as its own block, н/д when diskUsage is null", () => {
    const table = formatStatusReportTable({ ...baseReport, diskUsage: null });
    expect(table).toContain("Диск: н/д");
  });

  it("renders disk usage with ✅/⚠️ matching the same 80% threshold as formatStatusReport", () => {
    const healthy: DiskUsage = { path: "/", totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3, usedFraction: 0.5 };
    const full: DiskUsage = { path: "/", totalBytes: 100 * 1024 ** 3, availableBytes: 10 * 1024 ** 3, usedFraction: 0.9 };
    expect(formatStatusReportTable({ ...baseReport, diskUsage: healthy })).toContain("✅ Диск: 50%");
    expect(formatStatusReportTable({ ...baseReport, diskUsage: full })).toContain("⚠️ Диск: 90%");
  });
});

/**
 * Wraps a REAL `Kysely<Database>` so a `selectFrom(brokenTable)` call
 * rejects instead of ever reaching Postgres, while every other table's
 * query is passed straight through to the real connection unmodified. This
 * is the only way to deterministically exercise computeStatusReport's own
 * documented claim — "a query failure for any single check fails that
 * check CLOSED... one table's connection hiccup must not crash the whole
 * /status reply or hide every other table's real state" — against a REAL
 * db: actually breaking Postgres (dropping the table, revoking the role's
 * grants) would either be destructive or affect every other test file
 * sharing this same shared dev Postgres, which this file's own top comment
 * already establishes as something tests must never assume/force clean
 * state on.
 */
function withBrokenTable(real: Kysely<Database>, brokenTable: keyof Database): Kysely<Database> {
  const err = new Error(`simulated connection hiccup on ${String(brokenTable)}`);
  // A minimal fake query builder: any chain call (select/where/groupBy/
  // orderBy/limit/...) just returns itself so whatever shape of chain the
  // caller builds keeps working, and the three terminal methods
  // computeStatusReport actually calls reject instead of resolving.
  const failingBuilder: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "execute" || prop === "executeTakeFirst" || prop === "executeTakeFirstOrThrow") {
          return () => Promise.reject(err);
        }
        return () => failingBuilder;
      },
    },
  );
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "selectFrom") {
        return (table: keyof Database) => (table === brokenTable ? failingBuilder : target.selectFrom(table));
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Reflect.get's return type is inherently `any`; this is a plain pass-through Proxy trap forwarding every non-selectFrom property/method of the real Kysely instance, not a value this test constructs or narrows itself.
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("computeStatusReport (integration against a real local Postgres)", () => {
  let db: Kysely<Database>;
  const clearedHalt: HaltState = { haltNew: false, flattenAll: false, reason: null, setBy: null, setAtMs: null };

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — run docker compose up -d first.");
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    await db.deleteFrom("tickers").where("symbol", "=", SYM).execute();
    await db.deleteFrom("collection_runs").where("error", "=", "__TEST_STATUSREPORT_MARKER__").execute();
    // Only the "broken freshness-table" test below inserts into open_interest,
    // but cleaning it up unconditionally here (not inline in that test body)
    // means it's removed even if an assertion above it throws first — same
    // reasoning as the two lines above already being centralized in afterEach
    // rather than at the end of each test.
    await db.deleteFrom("open_interest").where("symbol", "=", SYM).execute();
  });

  afterAll(async () => db.destroy());

  it("passes the halt state through unchanged into the report", async () => {
    // Insert a fresh row for every gated table + a recent completed run, so
    // this test's own report shape isn't accidentally dominated by whatever
    // else might be in a shared dev DB — see this file's own top comment.
    await db
      .insertInto("tickers")
      .values({ symbol: SYM, category: "linear", last_price: "1", fetched_at: new Date() })
      .execute();
    await db
      .insertInto("collection_runs")
      .values({ status: "completed", started_at: new Date(), error: "__TEST_STATUSREPORT_MARKER__" })
      .execute();

    const halted: HaltState = { haltNew: true, flattenAll: false, reason: "test reason", setBy: "telegram", setAtMs: 1 };
    const report = await computeStatusReport(db, halted);

    expect(report.haltNew).toBe(true);
    expect(report.flattenAll).toBe(false);
    expect(report.haltReason).toBe("test reason");
  });

  it("detects a just-inserted row as fresh (age near zero, not stale)", async () => {
    await db
      .insertInto("tickers")
      .values({ symbol: SYM, category: "linear", last_price: "1", fetched_at: new Date() })
      .execute();

    const report = await computeStatusReport(db, clearedHalt);
    const tickers = report.tables.find((t) => t.table === "tickers");

    expect(tickers).toBeDefined();
    expect(tickers?.isStale).toBe(false);
    expect(tickers?.ageMs ?? Infinity).toBeLessThan(60_000);
  });

  it("reports a recent completed collection run and reflects it in lastCollectionRunAt", async () => {
    const runAt = new Date();
    await db
      .insertInto("collection_runs")
      .values({ status: "completed", started_at: runAt, error: "__TEST_STATUSREPORT_MARKER__" })
      .execute();

    const report = await computeStatusReport(db, clearedHalt);

    expect(report.collectionRunsRecentCompleted).toBeGreaterThanOrEqual(1);
    expect(report.lastCollectionRunAt).not.toBeNull();
    expect(Math.abs((report.lastCollectionRunAt?.getTime() ?? 0) - runAt.getTime())).toBeLessThan(2000);
  });

  it("counts liquidations in the recent window without treating a zero count as stale", async () => {
    const report = await computeStatusReport(db, clearedHalt);
    expect(typeof report.liquidationsRecentCount).toBe("number");
    // liquidations never appears in `tables` — it has no staleness gate at all.
    expect(report.tables.some((t) => t.table === "liquidations")).toBe(false);
  });

  // The three tests below are the actual point of this describe block's own
  // doc-comment ("a query failure for any single check fails that check
  // CLOSED... must not crash the whole /status reply or hide every other
  // table's real state") — none of the tests above ever make a real query
  // fail, so none of them would catch a regression that let an exception
  // escape computeStatusReport instead of being caught by its own .catch().
  // Together they exercise all four of computeStatusReport's own .catch()
  // fallbacks (checkFreshness, liquidationsRecentCount, runsRows, lastRunRow
  // — the last two share one test, since both are backed by collection_runs
  // and a real connection hiccup would hit both at once). Each forces a REAL
  // rejection out of a REAL Kysely<Database> call via withBrokenTable
  // (defined above) for exactly one table, and asserts BOTH that
  // computeStatusReport still resolves (the regression this exists to catch:
  // removing a `.catch()` would turn this `await` into a throw) AND that the
  // specific fallback value it's supposed to fail closed to is what actually
  // comes back — not merely "didn't crash".
  it("a broken freshness-table query (tickers) fails CLOSED for that table alone, without hiding open_interest's own real state", async () => {
    // A fresh row for a DIFFERENT gated table, so this test can prove its
    // real state survives untouched alongside the poisoned one — not just
    // that the whole report happens to come back "stale everywhere".
    await db
      .insertInto("open_interest")
      .values({ symbol: SYM, open_interest: "1", data_period: "5min", data_timestamp_ms: "1", fetched_at: new Date() })
      .execute();

    const brokenDb = withBrokenTable(db, "tickers");
    const report = await computeStatusReport(brokenDb, clearedHalt);

    const tickers = report.tables.find((t) => t.table === "tickers");
    expect(tickers).toEqual({
      table: "tickers",
      lastWriteAt: null,
      ageMs: null,
      staleAfterMs: 10 * 60_000,
      isStale: true,
    });

    const openInterest = report.tables.find((t) => t.table === "open_interest");
    expect(openInterest?.isStale).toBe(false); // untouched by tickers' own failure

    expect(report.overallHealthy).toBe(false); // one failed-closed gated table is enough to flip the overall verdict
  });

  it("a broken liquidations query falls back to a count of 0 instead of throwing", async () => {
    const brokenDb = withBrokenTable(db, "liquidations");
    const report = await computeStatusReport(brokenDb, clearedHalt);

    expect(report.liquidationsRecentCount).toBe(0);
    expect(report.tables.some((t) => t.table === "liquidations")).toBe(false); // still no staleness gate, even when broken
  });

  it("a broken collection_runs query falls back to zero completed/failed and no last-run time — treated the SAME as 'no runs ever', not silently reported healthy", async () => {
    // collection_runs backs BOTH runsRows and lastRunRow inside the same
    // Promise.all in computeStatusReport — a real connection hiccup on this
    // table hits both queries at once, exercising both of their independent
    // `.catch()` fallbacks in one real failure, same as production would see.
    const brokenDb = withBrokenTable(db, "collection_runs");
    const report = await computeStatusReport(brokenDb, clearedHalt);

    expect(report.collectionRunsRecentCompleted).toBe(0);
    expect(report.collectionRunsRecentFailed).toBe(0);
    expect(report.lastCollectionRunAt).toBeNull();
    // evaluateOverallHealthy's own "no collection run at all" branch — a
    // failed query must fail closed into the SAME verdict as genuinely never
    // having run, not silently pass as if nothing were wrong.
    expect(report.overallHealthy).toBe(false);
  });
});
