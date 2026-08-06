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

  it("separates every non-table block with a blank line, so Bot API 10.1 doesn't merge them into one run-on paragraph", () => {
    // Confirmed by direct testing against the real API (2026-08-06): a single
    // \n inside one markdown paragraph collapses to a space, and a table
    // needs a blank line before it or it merges into the preceding text as
    // literal `|` characters instead of rendering as a table block.
    const table = formatStatusReportTable(baseReport);
    const tableBlockStart = table.indexOf("| Таблица");
    expect(table.slice(tableBlockStart - 2, tableBlockStart)).toBe("\n\n");
  });
});

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
});
