import type { DigestStats } from "../market-data/collectionDigest.js";

/**
 * `parse_mode: "HTML"` rather than Telegram's MarkdownV2: MarkdownV2 requires
 * escaping ~18 special characters (`.`, `-`, `!`, `(`, `)`, ...) in every
 * dynamic value, including plain numbers with a decimal point — an easy way
 * to silently corrupt a message or have Telegram reject it outright. HTML
 * only needs `&`/`<`/`>` escaped and gives the same bold/monospace result,
 * so it is the safer choice for a message built from live numbers.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Signed delta against the previous digest's count for the same table —
 * `+1341`/`-42`/`±0`. Deliberately a SIGNED delta, not a percentage: a
 * percentage on a near-zero previous count (e.g. liquidations, often 0-2 per
 * window) produces meaningless or infinite figures, while a raw count
 * difference stays meaningful at any scale.
 */
function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  const delta = current - previous;
  if (delta === 0) return " (±0)";
  return delta > 0 ? ` (+${delta})` : ` (${delta})`;
}

/**
 * Short and readable on a phone lock screen — this exists so the owner can
 * glance at a push notification and know the collector is alive without
 * opening a terminal (RUNBOOK.md §4's manual `systemctl status` check is the
 * fallback when this message DOESN'T arrive, not the everyday path).
 *
 * `previous` is the immediately-prior digest's own DigestStats (collector.ts
 * holds onto it between sends) — when supplied, every row shows a signed
 * delta against that same table's count last time, so a glance answers "is
 * this period keeping pace with the last one" without mentally diffing two
 * separate past messages. Optional and absent on the very first digest after
 * a fresh process start, by construction — there is nothing to compare yet.
 */
export function formatDigestMessage(stats: DigestStats, previous?: DigestStats): string {
  const lines: string[] = [];

  lines.push(`<b>📊 Сбор данных</b>`);
  lines.push(`${formatTime(stats.windowStart)} → ${formatTime(stats.windowEnd)}`);
  lines.push("");
  lines.push(`Символов в юниверсе: <b>${stats.universeSize}</b>`);
  lines.push(`Циклов: ✅ ${stats.collectionRunsCompleted}  ❌ ${stats.collectionRunsFailed}`);
  lines.push("");
  lines.push(
    `<code>tickers          ${stats.tickersWritten}${formatDelta(stats.tickersWritten, previous?.tickersWritten)}</code>`,
  );
  lines.push(
    `<code>funding_rates    ${stats.fundingRatesWritten}${formatDelta(stats.fundingRatesWritten, previous?.fundingRatesWritten)}</code>`,
  );
  lines.push(
    `<code>open_interest    ${stats.openInterestWritten}${formatDelta(stats.openInterestWritten, previous?.openInterestWritten)}</code>`,
  );
  lines.push(
    `<code>long_short_ratio ${stats.longShortRatioWritten}${formatDelta(stats.longShortRatioWritten, previous?.longShortRatioWritten)}</code>`,
  );
  lines.push(
    `<code>orderbook_levels ${stats.orderbookLevelsWritten}${formatDelta(stats.orderbookLevelsWritten, previous?.orderbookLevelsWritten)}</code>`,
  );
  lines.push(
    `<code>liquidations     ${stats.liquidationsWritten}${formatDelta(stats.liquidationsWritten, previous?.liquidationsWritten)}</code>`,
  );

  if (stats.lastRunAt) {
    lines.push("");
    lines.push(`Последний цикл: ${formatTime(stats.lastRunAt)}`);
  }

  if (stats.recentFailures.length > 0) {
    lines.push("");
    lines.push(`<b>⚠️ Ошибки за период:</b>`);
    for (const failure of stats.recentFailures) {
      const errorText = failure.error ? escapeHtml(failure.error).slice(0, 200) : "без описания";
      lines.push(`${formatTime(failure.startedAt)}: <i>${errorText}</i>`);
    }
  }

  return lines.join("\n");
}

/**
 * Bot API 10.1's `sendRichMessage` (notify/telegram.ts) parses GFM-style pipe
 * tables out of a markdown string into a real client-rendered table — this is
 * that markdown string, a table-based counterpart to `formatDigestMessage`'s
 * HTML `<code>`-block layout. Escaping is markdown's own (`|` inside a cell
 * would break the table grid, so it's replaced rather than escaped — none of
 * this module's values legitimately contain a literal `|`).
 */
function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * Bot API 10.1 collapses a single `\n` inside one markdown paragraph into a
 * plain space (confirmed by direct test against the real API, 2026-08-06 —
 * NOT documented anywhere). A table is only recognized as its own block when
 * preceded by a BLANK line; without one it merges into the preceding
 * paragraph as literal `|`-text instead of a real table. Every element below
 * that should stand on its own line is therefore its own "block" here,
 * joined with `\n\n` — EXCEPT the table's own header/separator/data rows,
 * which must stay single-`\n`-joined among themselves.
 */
export function formatDigestTable(stats: DigestStats, previous?: DigestStats): string {
  const blocks: string[] = [];

  blocks.push(`## 📊 Сбор данных: ${formatTime(stats.windowStart)} → ${formatTime(stats.windowEnd)}`);

  blocks.push(
    `Символов в юниверсе: **${String(stats.universeSize)}**  ·  Циклов: ✅ ${String(stats.collectionRunsCompleted)}  ❌ ${String(stats.collectionRunsFailed)}`,
  );

  const tableRows = ["| Таблица | Записей | Δ к прошлому разу |", "|---|---|---|"];
  const rows: [string, number, number | undefined][] = [
    ["tickers", stats.tickersWritten, previous?.tickersWritten],
    ["funding_rates", stats.fundingRatesWritten, previous?.fundingRatesWritten],
    ["open_interest", stats.openInterestWritten, previous?.openInterestWritten],
    ["long_short_ratio", stats.longShortRatioWritten, previous?.longShortRatioWritten],
    ["orderbook_levels", stats.orderbookLevelsWritten, previous?.orderbookLevelsWritten],
    ["liquidations", stats.liquidationsWritten, previous?.liquidationsWritten],
  ];
  for (const [name, current, prevValue] of rows) {
    const delta = formatDelta(current, prevValue).trim();
    tableRows.push(`| ${name} | ${String(current)} | ${delta === "" ? "—" : escapeMdCell(delta)} |`);
  }
  blocks.push(tableRows.join("\n"));

  if (stats.lastRunAt) {
    blocks.push(`Последний цикл: ${formatTime(stats.lastRunAt)}`);
  }

  if (stats.recentFailures.length > 0) {
    const failureLines = ["**⚠️ Ошибки за период:**"];
    for (const failure of stats.recentFailures) {
      const errorText = failure.error ? escapeMdCell(failure.error).slice(0, 200) : "без описания";
      failureLines.push(`${formatTime(failure.startedAt)}: _${errorText}_`);
    }
    blocks.push(failureLines.join("\n\n"));
  }

  return blocks.join("\n\n");
}
