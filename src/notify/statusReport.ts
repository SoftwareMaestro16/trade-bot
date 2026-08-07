import type { Kysely } from "kysely";
import type { HaltState } from "../killswitch/haltState.js";
import type { Database } from "../storage/schema.js";
import { checkDiskUsage } from "./diskUsage.js";
import type { DiskUsage } from "./diskUsage.js";

/**
 * Owner's own worry, verbatim: "одним сообщением выдает что работает что не
 * работает, прибавлялись ли в базу данных какие-то новые данные" (one message
 * showing what's working/not, whether new data landed in the DB). Deliberately
 * queried from killswitch-listener.ts, NOT collector.ts: RR-31's whole point is
 * that this process survives collector.ts hanging or dying — a status check
 * that could only ever run FROM the process it's checking would be useless in
 * exactly the failure mode ("running but writing nothing" / not running at
 * all) it exists to catch.
 *
 * Reuses `storage/schema.ts`'s own `Database` type directly rather than a
 * bespoke subset — that type already declares exactly the market-data tables
 * this module reads (tickers/open_interest/orderbook_levels/funding_rates/
 * long_short_ratio/liquidations/collection_runs), so a hand-rolled duplicate
 * would only be another place for those two definitions to drift apart.
 */

// The 5 tables checked for write-freshness — deliberately an explicit list,
// not "every key of Database except X/Y": Database also has
// pending_telegram_messages (no fetched_at column, and not a market-data
// collector anyway) and collection_runs/liquidations (handled separately
// below, not via this staleness gate). An explicit list keeps this exactly
// as wide as intended regardless of what else Database ever grows.
type FreshnessTable = "tickers" | "open_interest" | "orderbook_levels" | "funding_rates" | "long_short_ratio";

// Expected write cadence per table (collector.ts's own *_INTERVAL_MS), times a
// generous ~10x margin — same reasoning as notify/healthcheck.ts's own
// DB_STALE_AFTER_MS: tolerate several missed cycles before calling it a real
// problem, not a transient blip. `liquidations` is handled separately (not
// here): it's WebSocket-event-driven (FR-107), not polled on a cadence — a
// quiet market can legitimately produce zero liquidation events for hours,
// so "no recent row" there is not evidence of anything broken, unlike every
// other table.
const STALE_AFTER_MS: Record<FreshnessTable, number> = {
  tickers: 10 * 60_000,
  open_interest: 10 * 60_000,
  orderbook_levels: 10 * 60_000,
  funding_rates: 20 * 60_000, // mixes 60s 'predicted' writes and 5min 'settled' writes — sized to the slower of the two
  long_short_ratio: 20 * 60_000,
};

const LIQUIDATIONS_RECENT_WINDOW_MS = 60 * 60_000;
const COLLECTION_RUNS_RECENT_WINDOW_MS = 15 * 60_000;

export interface TableFreshness {
  table: string;
  lastWriteAt: Date | null;
  ageMs: number | null;
  staleAfterMs: number | null; // null = no staleness gate applies (liquidations)
  isStale: boolean;
}

export interface StatusReport {
  haltNew: boolean;
  flattenAll: boolean;
  haltReason: string | null;
  tables: TableFreshness[];
  liquidationsRecentCount: number;
  collectionRunsRecentCompleted: number;
  collectionRunsRecentFailed: number;
  lastCollectionRunAt: Date | null;
  overallHealthy: boolean;
  /** null when unavailable (e.g. this codebase's own Windows dev environment) — see diskUsage.ts's own doc comment for why that's never fatal to the rest of this report. */
  diskUsage: DiskUsage | null;
}

/** 2026-08-07: interim visibility until migrations/1786109550746_orderbook-levels-compression.sql's chunk closes 2026-08-13 — see diskUsage.ts. Does NOT affect overallHealthy: a full disk is a real problem, but it isn't the SAME "is data still flowing" question overallHealthy answers, and conflating them would make overallHealthy flip on disk pressure that hasn't actually stopped anything yet. */
const DISK_USAGE_WARN_FRACTION = 0.8;

/**
 * Pure overall verdict, split out from `computeStatusReport` for the same
 * testability reason as `evaluateStaleness` below. Owner's own framing: "а то
 * вдруг работает и нихуя не пишется" — ANY stale gated table, or no
 * collection cycle at all in the recent window, is enough to flip the
 * overall verdict, even if some other tables individually look fine. A
 * partial failure is still a failure worth surfacing loudly in one glance.
 */
export function evaluateOverallHealthy(
  tables: TableFreshness[],
  lastCollectionRunAt: Date | null,
  now: Date,
): boolean {
  return (
    tables.every((t) => !t.isStale) &&
    lastCollectionRunAt !== null &&
    now.getTime() - lastCollectionRunAt.getTime() < COLLECTION_RUNS_RECENT_WINDOW_MS
  );
}

/**
 * Pure staleness verdict, split out from `checkFreshness` below specifically
 * so it's testable with constructed timestamps — not dependent on a live
 * table's actual contents, which this project's tests deliberately never
 * assume are empty (see test/notify/statusReport.test.ts's own comment on
 * why: a shared local dev Postgres can legitimately already hold real
 * collector.ts data, same as happened in this very project this session).
 */
export function evaluateStaleness(lastWriteAt: Date | null, now: Date, staleAfterMs: number): boolean {
  if (lastWriteAt === null) return true;
  return now.getTime() - lastWriteAt.getTime() > staleAfterMs;
}

async function checkFreshness(db: Kysely<Database>, table: FreshnessTable, now: Date): Promise<TableFreshness> {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.max("fetched_at").as("latest"))
    .executeTakeFirst();
  const lastWriteAt = row?.latest ? new Date(row.latest) : null;
  const ageMs = lastWriteAt ? now.getTime() - lastWriteAt.getTime() : null;
  const staleAfterMs = STALE_AFTER_MS[table];
  return {
    table,
    lastWriteAt,
    ageMs,
    staleAfterMs,
    isStale: evaluateStaleness(lastWriteAt, now, staleAfterMs),
  };
}

/**
 * A query failure for any single check fails that check CLOSED (stale/absent)
 * rather than throwing — same "when in doubt, withhold trust" direction as
 * healthcheck.ts's own isDataFresh. One table's connection hiccup must not
 * crash the whole /status reply or hide every other table's real state.
 */
export async function computeStatusReport(db: Kysely<Database>, haltState: HaltState): Promise<StatusReport> {
  const now = new Date();
  const freshnessTables: FreshnessTable[] = [
    "tickers",
    "open_interest",
    "orderbook_levels",
    "funding_rates",
    "long_short_ratio",
  ];

  const tables = await Promise.all(
    freshnessTables.map((table) =>
      checkFreshness(db, table, now).catch(
        (): TableFreshness => ({
          table,
          lastWriteAt: null,
          ageMs: null,
          staleAfterMs: STALE_AFTER_MS[table],
          isStale: true,
        }),
      ),
    ),
  );

  const liquidationsCutoff = new Date(now.getTime() - LIQUIDATIONS_RECENT_WINDOW_MS);
  const liquidationsRecentCount = await db
    .selectFrom("liquidations")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("received_at", ">=", liquidationsCutoff)
    .executeTakeFirst()
    .then((r) => Number(r?.count ?? 0))
    .catch(() => 0);

  const runsCutoff = new Date(now.getTime() - COLLECTION_RUNS_RECENT_WINDOW_MS);
  const [runsRows, lastRunRow] = await Promise.all([
    db
      .selectFrom("collection_runs")
      .select(["status", ({ fn }) => fn.countAll<string>().as("count")])
      .where("started_at", ">=", runsCutoff)
      .groupBy("status")
      .execute()
      .catch(() => []),
    db
      .selectFrom("collection_runs")
      .select("started_at")
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst()
      .catch(() => undefined),
  ]);

  const collectionRunsRecentCompleted = Number(runsRows.find((r) => r.status === "completed")?.count ?? 0);
  const collectionRunsRecentFailed = Number(runsRows.find((r) => r.status === "failed")?.count ?? 0);
  const lastCollectionRunAt = lastRunRow?.started_at ? new Date(lastRunRow.started_at) : null;

  const overallHealthy = evaluateOverallHealthy(tables, lastCollectionRunAt, now);

  return {
    haltNew: haltState.haltNew,
    flattenAll: haltState.flattenAll,
    haltReason: haltState.reason,
    tables,
    liquidationsRecentCount,
    collectionRunsRecentCompleted,
    collectionRunsRecentFailed,
    lastCollectionRunAt,
    overallHealthy,
    diskUsage: checkDiskUsage(),
  };
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "нет данных";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${String(minutes)} мин назад`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} ч ${String(minutes % 60)} мин назад`;
}

function formatDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

/** null (checkDiskUsage couldn't stat the path — e.g. a dev machine) renders as an explicit "н/д", never silently omitted, so a broken check is visible, not indistinguishable from "nothing to report." */
function formatDiskUsageLine(diskUsage: DiskUsage | null): string {
  if (!diskUsage) return "Диск: н/д";
  const usedPct = Math.round(diskUsage.usedFraction * 100);
  const mark = diskUsage.usedFraction >= DISK_USAGE_WARN_FRACTION ? "⚠️" : "✅";
  return `${mark} Диск: ${String(usedPct)}% занято, свободно ${formatBytes(diskUsage.availableBytes)} из ${formatBytes(diskUsage.totalBytes)}`;
}

/** Mirrors notify/formatDigest.ts's HTML-escaping choice and reasoning — see that file. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Mirrors notify/formatDigest.ts's `escapeMdCell` choice and reasoning — see
 * that file: a literal `|` in a value dropped into the Bot API 10.1 rich
 * markdown string (formatStatusReportTable below) reads as a pipe-table cell
 * boundary to Telegram's parser, so it is escaped here the same way, whether
 * or not the value happens to land inside an actual `| ... |` table row.
 */
function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];

  lines.push(`<b>${report.overallHealthy ? "✅" : "⚠️"} Статус Фазы 1</b>`);
  lines.push("");

  lines.push("<b>Kill switch</b>");
  lines.push(`HALT_NEW: ${report.haltNew ? "🛑 on" : "✅ off"}`);
  lines.push(`FLATTEN_ALL: ${report.flattenAll ? "🛑 on" : "✅ off"}`);
  if (report.haltReason) lines.push(`Причина: ${escapeHtml(report.haltReason)}`);
  lines.push("");

  lines.push("<b>Данные (свежесть)</b>");
  for (const t of report.tables) {
    const mark = t.isStale ? "⚠️" : "✅";
    lines.push(`<code>${mark} ${t.table.padEnd(16)} ${formatAge(t.ageMs)}</code>`);
  }
  lines.push(`<code>ℹ️ liquidations      ${String(report.liquidationsRecentCount)} за последний час</code>`);
  lines.push("");

  lines.push("<b>Циклы сбора</b> (последние 15 мин)");
  lines.push(`✅ ${String(report.collectionRunsRecentCompleted)}  ❌ ${String(report.collectionRunsRecentFailed)}`);
  lines.push(
    report.lastCollectionRunAt
      ? `Последний цикл: ${formatDateTime(report.lastCollectionRunAt)}`
      : "Последний цикл: ни одного не найдено вообще",
  );
  lines.push("");
  lines.push(formatDiskUsageLine(report.diskUsage));

  return lines.join("\n");
}

/**
 * Table-based counterpart to `formatStatusReport`, for `sendRichMessage`
 * (Bot API 10.1 — see notify/telegram.ts's own doc comment). Same content,
 * rendered as a real client-side table via a GFM-style markdown pipe table
 * instead of monospace `<code>` alignment.
 */
/**
 * Bot API 10.1 collapses a single `\n` inside one markdown paragraph into a
 * plain space (confirmed by direct test against the real API, 2026-08-06 —
 * NOT documented anywhere, the first version of this function shipped
 * without this and rendered as one run-on wall of text). A table is only
 * recognized as its own block when preceded by a BLANK line; without one it
 * merges into the preceding paragraph as literal `|`-text instead of a real
 * table. Every element below that should visually stand on its own line is
 * therefore its own "block" here, joined with `\n\n` — EXCEPT a table's own
 * header/separator/data rows, which must stay single-`\n`-joined among
 * themselves (a blank line INSIDE a table would split it into two).
 */
export function formatStatusReportTable(report: StatusReport): string {
  const blocks: string[] = [];

  blocks.push(`# ${report.overallHealthy ? "✅" : "⚠️"} Статус Фазы 1`);

  const killSwitchLine = [
    `**Kill switch:** HALT_NEW ${report.haltNew ? "🛑 on" : "✅ off"}`,
    `FLATTEN_ALL ${report.flattenAll ? "🛑 on" : "✅ off"}`,
  ].join("  ·  ");
  blocks.push(
    report.haltReason ? `${killSwitchLine}  ·  Причина: ${escapeMdCell(report.haltReason)}` : killSwitchLine,
  );

  blocks.push("**Данные (свежесть)**");

  const tableRows = ["| Таблица | Статус | Возраст |", "|---|---|---|"];
  for (const t of report.tables) {
    tableRows.push(`| ${t.table} | ${t.isStale ? "⚠️" : "✅"} | ${formatAge(t.ageMs)} |`);
  }
  tableRows.push(`| liquidations | ℹ️ | ${String(report.liquidationsRecentCount)} за последний час |`);
  blocks.push(tableRows.join("\n"));

  const lastRunText = report.lastCollectionRunAt
    ? `Последний цикл: ${formatDateTime(report.lastCollectionRunAt)}`
    : "Последний цикл: ни одного не найдено вообще";
  blocks.push(
    `**Циклы сбора** (последние 15 мин): ✅ ${String(report.collectionRunsRecentCompleted)}  ❌ ${String(report.collectionRunsRecentFailed)}  ·  ${lastRunText}`,
  );

  blocks.push(formatDiskUsageLine(report.diskUsage));

  return blocks.join("\n\n");
}
