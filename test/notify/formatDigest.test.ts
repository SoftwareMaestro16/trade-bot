import { describe, expect, it } from "vitest";
import { formatDigestMessage, formatDigestTable } from "../../src/notify/formatDigest.js";
import type { DigestStats } from "../../src/market-data/collectionDigest.js";

function baseStats(overrides: Partial<DigestStats> = {}): DigestStats {
  return {
    windowStart: new Date("2026-08-06T04:00:00Z"),
    windowEnd: new Date("2026-08-06T12:00:00Z"),
    universeSize: 234,
    tickersWritten: 1401,
    fundingRatesWritten: 234,
    openInterestWritten: 234,
    longShortRatioWritten: 234,
    orderbookLevelsWritten: 9831,
    liquidationsWritten: 12,
    collectionRunsCompleted: 32,
    collectionRunsFailed: 0,
    lastRunAt: new Date("2026-08-06T11:58:00Z"),
    recentFailures: [],
    ...overrides,
  };
}

describe("formatDigestMessage", () => {
  it("includes the universe size, run counts, and per-table row counts", () => {
    const message = formatDigestMessage(baseStats());

    expect(message).toContain("234");
    expect(message).toContain("✅ 32");
    expect(message).toContain("❌ 0");
    expect(message).toContain("1401");
    expect(message).toContain("9831");
  });

  it("uses HTML tags Telegram's parse_mode:HTML understands, not MarkdownV2 syntax", () => {
    const message = formatDigestMessage(baseStats());
    expect(message).toContain("<b>");
    expect(message).toContain("<code>");
    // No raw MarkdownV2 escape backslashes should ever appear — this message
    // is never meant to be sent with parse_mode:MarkdownV2.
    expect(message).not.toContain("\\.");
  });

  it("omits the failures section entirely when there are none", () => {
    const message = formatDigestMessage(baseStats({ recentFailures: [] }));
    expect(message).not.toContain("Ошибки");
  });

  it("lists recent failures and HTML-escapes error text to prevent malformed markup", () => {
    const message = formatDigestMessage(
      baseStats({
        collectionRunsFailed: 2,
        recentFailures: [
          { startedAt: new Date("2026-08-06T10:00:00Z"), error: "connect ECONNREFUSED <api.bybit.com>" },
          { startedAt: new Date("2026-08-06T06:00:00Z"), error: null },
        ],
      }),
    );

    expect(message).toContain("Ошибки");
    expect(message).toContain("&lt;api.bybit.com&gt;");
    expect(message).not.toContain("<api.bybit.com>"); // unescaped form must not appear literally as markup
    expect(message).toContain("без описания");
  });

  it("handles a symbol-less / activity-less window without throwing (FM-07: a valid outcome)", () => {
    const message = formatDigestMessage(
      baseStats({
        universeSize: 0,
        tickersWritten: 0,
        fundingRatesWritten: 0,
        openInterestWritten: 0,
        longShortRatioWritten: 0,
        orderbookLevelsWritten: 0,
        liquidationsWritten: 0,
        collectionRunsCompleted: 0,
        lastRunAt: null,
      }),
    );
    expect(message).toContain("0");
    expect(message).not.toContain("Последний цикл");
  });

  it("shows ±0 when the count is unchanged from the previous digest", () => {
    const message = formatDigestMessage(baseStats({ tickersWritten: 1401 }), baseStats({ tickersWritten: 1401 }));
    expect(message).toContain("1401 (±0)");
  });

  it("shows a negative delta with a single leading minus when a count drops", () => {
    const message = formatDigestMessage(baseStats({ tickersWritten: 1000 }), baseStats({ tickersWritten: 1200 }));
    expect(message).toContain("1000 (-200)");
    expect(message).not.toContain("(--200)");
    expect(message).not.toContain("(+-200)");
  });
});

describe("formatDigestTable (Bot API 10.1 sendRichMessage markdown)", () => {
  it("produces a GFM-style pipe table with a header separator row", () => {
    const table = formatDigestTable(baseStats());
    expect(table).toContain("| Таблица | Записей | Δ к прошлому разу |");
    expect(table).toContain("|---|---|---|");
    expect(table).toContain("| tickers | 1401 |");
    expect(table).toContain("| orderbook_levels | 9831 |");
  });

  it("shows a delta column against the previous digest, and — for no previous digest", () => {
    const withoutPrevious = formatDigestTable(baseStats());
    expect(withoutPrevious).toContain("| tickers | 1401 | — |");

    const withPrevious = formatDigestTable(baseStats(), baseStats({ tickersWritten: 1200 }));
    expect(withPrevious).toContain("| tickers | 1401 | (+201) |");
  });

  it("uses markdown emphasis syntax for the universe size, not HTML tags anywhere", () => {
    const table = formatDigestTable(baseStats());
    expect(table).toContain("**234**");
    expect(table).not.toContain("<b>");
    expect(table).not.toContain("<code>");
  });

  it("escapes a literal pipe in an error message so it can't break the table grid", () => {
    const table = formatDigestTable(
      baseStats({
        recentFailures: [{ startedAt: new Date("2026-08-06T10:00:00Z"), error: "timeout | retry exhausted" }],
      }),
    );
    expect(table).toContain("timeout \\| retry exhausted");
  });

  it("precedes the table with a blank line, so Bot API 10.1 renders it as a real table block, not literal text", () => {
    // Confirmed by direct testing against the real API (2026-08-06): a table
    // merges into the preceding paragraph as literal `|` characters unless a
    // blank line separates it — see notify/statusReport.ts's identical fix.
    const table = formatDigestTable(baseStats());
    const tableBlockStart = table.indexOf("| Таблица");
    expect(table.slice(tableBlockStart - 2, tableBlockStart)).toBe("\n\n");
  });

  it("shows ±0 in the delta cell when the count is unchanged from the previous digest", () => {
    const table = formatDigestTable(baseStats({ tickersWritten: 1401 }), baseStats({ tickersWritten: 1401 }));
    expect(table).toContain("| tickers | 1401 | (±0) |");
  });

  it("shows a negative delta with a single leading minus when a count drops", () => {
    const table = formatDigestTable(baseStats({ tickersWritten: 1000 }), baseStats({ tickersWritten: 1200 }));
    expect(table).toContain("| tickers | 1000 | (-200) |");
    expect(table).not.toContain("(--200)");
  });

  it("omits the 'Последний цикл' line when lastRunAt is null", () => {
    const table = formatDigestTable(baseStats({ lastRunAt: null }));
    expect(table).not.toContain("Последний цикл");
  });

  it("omits the failures section entirely when there are none", () => {
    const table = formatDigestTable(baseStats({ recentFailures: [] }));
    expect(table).not.toContain("Ошибки");
  });
});
