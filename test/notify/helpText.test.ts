import { describe, expect, it } from "vitest";
import { formatHelpTable } from "../../src/notify/helpText.js";
import { COMMAND_DOCS } from "../../src/killswitch/commandRouter.js";
import type { CommandDoc } from "../../src/killswitch/commandRouter.js";

describe("formatHelpTable", () => {
  it("renders a heading block and a table block, separated by a blank line (Bot API 10.1 block-boundary rule)", () => {
    const text = formatHelpTable(COMMAND_DOCS);
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe("# ℹ️ Команды");
    expect(blocks[1]?.startsWith("| Команда | Что делает |")).toBe(true);
    expect(blocks[1]?.split("\n")[1]).toBe("|---|---|");
  });

  it("includes one row per command, in the same order as COMMAND_DOCS", () => {
    const text = formatHelpTable(COMMAND_DOCS);
    const rows = text.split("\n\n")[1]?.split("\n").slice(2) ?? [];
    expect(rows).toHaveLength(COMMAND_DOCS.length);
    COMMAND_DOCS.forEach((doc, i) => {
      expect(rows[i]).toContain(doc.usage);
      expect(rows[i]).toContain(doc.description);
    });
  });

  it("every documented command appears with its /-prefixed usage as an inline code span", () => {
    const text = formatHelpTable(COMMAND_DOCS);
    for (const doc of COMMAND_DOCS) {
      expect(text).toContain(`| \`${doc.usage}\` |`);
    }
  });

  it("escapes a literal '|' in a description so it can't be mistaken for a pipe-table cell boundary", () => {
    const docs: CommandDoc[] = [{ usage: "/x", description: "a | b" }];
    const text = formatHelpTable(docs);
    expect(text).toContain("a \\| b");
  });

  it("produces exactly one table row per entry even with a single command", () => {
    const docs: CommandDoc[] = [{ usage: "/only", description: "the only one" }];
    const text = formatHelpTable(docs);
    const rows = text.split("\n\n")[1]?.split("\n").slice(2) ?? [];
    expect(rows).toEqual(["| `/only` | the only one |"]);
  });
});
