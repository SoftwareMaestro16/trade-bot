import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  buildCombinedReport,
  buildDeterministicCaption,
  resolveReportCaption,
} from "../../src/emulation/reportDelivery.js";
import type { GenerateReportsResult } from "../../src/emulation/reportGenerator.js";
import type { TradeReportInput } from "../../src/analysis/llm/tools/tradeReportTool.js";
import { buildToolset } from "../../src/analysis/llm/index.js";
import type { LlmClient } from "../../src/analysis/llm/index.js";
import { LlmError } from "../../src/analysis/llm/index.js";

const REPORTS: GenerateReportsResult = {
  summaryMarkdown: "# Отчёт\n\n| a | b |\n| - | - |\n",
  tradesCsv: "col1,col2\n1,2\n",
  equityCurveCsv: "date,eq\n2026-08-06,1000\n",
  aggregates: [],
};

const INPUT: TradeReportInput = {
  runId: "run-9",
  startingDeposit: new Big("1000"),
  endingEquity: new Big("995.09"),
  tradeCount: 9,
  winCount: 1,
  fundingIncome: new Big("0.10"),
  basisPnl: new Big("-2.18"),
  fees: new Big("-2.75"),
  slippage: new Big("-0.08"),
  borrowCost: new Big("0"),
};

class FakeLlm implements LlmClient {
  constructor(private readonly reply: string) {}
  complete(): Promise<string> {
    return Promise.resolve(this.reply);
  }
}
class DeadLlm implements LlmClient {
  complete(): Promise<string> {
    return Promise.reject(new LlmError("HTTP 429"));
  }
}

describe("buildCombinedReport", () => {
  it("склеивает три артефакта в один .md с секциями", () => {
    const { filename, content } = buildCombinedReport("run-9", REPORTS);
    expect(filename).toBe("paper_report_run-9.md");
    expect(content).toContain("# Отчёт");
    expect(content).toContain("## Сделки");
    expect(content).toContain("col1,col2");
    expect(content).toContain("## Кривая эквити");
    expect(content).toContain("date,eq");
  });
});

describe("buildDeterministicCaption", () => {
  it("собирает подпись из чисел: нетто, win-rate, главный источник убытка", () => {
    const cap = buildDeterministicCaption(INPUT);
    expect(cap).toContain('Эмуляция "run-9"');
    expect(cap).toContain("-$4.91"); // netPnl
    expect(cap).toContain("win-rate 11.1%");
    expect(cap).toContain("комиссии"); // dominant loss driver (-2.75)
  });
});

describe("resolveReportCaption — LLM-first, фолбэк на скрипт", () => {
  it("берёт резюме LLM, когда оно есть", async () => {
    const toolset = buildToolset(new FakeLlm("Съели комиссии, funding почти ноль."));
    const r = await resolveReportCaption(INPUT, toolset);
    expect(r.source).toBe("llm");
    expect(r.caption).toBe("Съели комиссии, funding почти ноль.");
  });

  it("падает на детерминированную подпись, когда LLM сбоит", async () => {
    const toolset = buildToolset(new DeadLlm());
    const r = await resolveReportCaption(INPUT, toolset);
    expect(r.source).toBe("script");
    expect(r.caption).toContain('Эмуляция "run-9"');
  });

  it("использует скрипт, когда LLM вообще не настроен (toolset=null)", async () => {
    const r = await resolveReportCaption(INPUT, null);
    expect(r.source).toBe("script");
    expect(r.caption).toContain("win-rate");
  });
});
