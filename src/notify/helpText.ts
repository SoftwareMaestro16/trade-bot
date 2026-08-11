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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * HTML-версия помощи для editMessageText (parseMode "HTML") — в отличие от
 * formatHelpTable, которая рендерит rich-таблицу через sendRichMessage
 * отдельным сообщением. Нужна для показа помощи ВНУТРИ меню на месте (кнопка
 * ❓ Помощь редактирует то же сообщение, а не шлёт новое). Таблиц у
 * editMessageText нет, поэтому список — командой в <code>, описанием обычным
 * текстом.
 */
export function formatHelpText(docs: readonly CommandDoc[]): string {
  const lines = ["<b>ℹ️ Команды</b>", ""];
  for (const doc of docs) {
    lines.push(`<code>${escapeHtml(doc.usage)}</code>`);
    lines.push(escapeHtml(doc.description));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
