import type { CommandDoc } from "../killswitch/commandRouter.js";

/**
 * Owner's own request: "/help красиво с маркдаун форматированием в таблице
 * выведет все команды как использовать и для чего" — reuses the exact Bot
 * API 10.1 rich-table mechanism statusReport.ts's formatStatusReportTable
 * already established for /status (see that file's own doc comment for the
 * full rationale: `sendRichMessage`'s `rich_message.markdown` renders a
 * real GFM-style pipe table client-side, unlike `sendMessage`'s HTML/
 * MarkdownV2 which has no table entity at all). Kept as its own small file
 * rather than added to statusReport.ts: that file is specifically about
 * data-freshness/kill-switch status, not a general home for every
 * Telegram-formatted message this bot ever sends.
 */

/** Mirrors notify/statusReport.ts's own escapeMdCell — same reasoning: a literal `|` in a cell reads as a pipe-table boundary to Telegram's parser. Duplicated rather than shared, same precedent as that file's own duplication of notify/formatDigest.ts's version. */
function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function formatHelpTable(docs: readonly CommandDoc[]): string {
  const rows = ["| Команда | Что делает |", "|---|---|"];
  for (const doc of docs) {
    rows.push(`| \`${escapeMdCell(doc.usage)}\` | ${escapeMdCell(doc.description)} |`);
  }

  // Same blank-line-between-blocks requirement formatStatusReportTable's own
  // doc comment documents (Bot API 10.1 collapses a single \n inside one
  // markdown paragraph into a space) — heading and table are separate blocks.
  return ["# ℹ️ Команды", rows.join("\n")].join("\n\n");
}
