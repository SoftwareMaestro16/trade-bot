import Big from "big.js";
import { describe, expect, it } from "vitest";
import { LlmError } from "../../../src/analysis/llm/client.js";
import type { LlmClient, LlmPrompt } from "../../../src/analysis/llm/client.js";
import { MarketAssessmentTool } from "../../../src/analysis/llm/tools/marketAssessmentTool.js";
import { TradeReportTool } from "../../../src/analysis/llm/tools/tradeReportTool.js";
import { OpportunityOutlookTool, computeOutlook } from "../../../src/analysis/llm/tools/opportunityOutlookTool.js";
import { buildToolset, ToolRegistry } from "../../../src/analysis/llm/registry.js";
import { assessMarket } from "../../../src/analysis/marketAssessment.js";
import type { SymbolMarketStat } from "../../../src/analysis/marketAssessment.js";

/** Записывает полученный промпт и отдаёт заранее заданный ответ (Dependency Inversion в действии). */
class FakeLlmClient implements LlmClient {
  lastPrompt: LlmPrompt | undefined;
  constructor(private readonly response: string) {}
  complete(prompt: LlmPrompt): Promise<string> {
    this.lastPrompt = prompt;
    return Promise.resolve(this.response);
  }
}

/** Всегда падает — для проверки штатной деградации. */
class ThrowingLlmClient implements LlmClient {
  complete(): Promise<string> {
    return Promise.reject(new LlmError("LLM недоступен (HTTP 503)", 503));
  }
}

const OPPORTUNITY: SymbolMarketStat = {
  symbol: "GOODUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.001"),
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.0001"),
};
// Ликвидная, funding есть, но базис слишком волатилен — near-miss по базису.
const NEAR_MISS_BASIS: SymbolMarketStat = {
  symbol: "WILDUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.002"),
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.0022"), // room 0.005 / 0.0022 = 2.27 sigma < 3
};
// Ликвидная, базис спокойный, но funding чуть ниже премиального порога.
const NEAR_MISS_FUNDING: SymbolMarketStat = {
  symbol: "CALMUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.0004"), // ниже 0.0005
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.0001"),
};

describe("MarketAssessmentTool", () => {
  it("считает оценку детерминированно и вплетает её в промпт, возвращая резюме", async () => {
    const llm = new FakeLlmClient("Рынок непригоден.");
    const tool = new MarketAssessmentTool(llm);
    const result = await tool.run({ stats: [NEAR_MISS_BASIS] });

    expect(result.data.suitabilityScore).toBe(0);
    expect(result.narrative).toBe("Рынок непригоден.");
    expect(result.llmError).toBeNull();
    // Промпт содержит реальные числа, а система запрещает советы.
    expect(llm.lastPrompt!.user).toContain("Оценка пригодности рынка: 0/100");
    expect(llm.lastPrompt!.system).toContain("НЕ даёшь торговых советов");
  });

  it("деградирует штатно при сбое LLM: данные есть, narrative=null", async () => {
    const tool = new MarketAssessmentTool(new ThrowingLlmClient());
    const result = await tool.run({ stats: [OPPORTUNITY] });

    expect(result.data.opportunities).toHaveLength(1); // детерминированная часть цела
    expect(result.narrative).toBeNull();
    expect(result.llmError).toContain("503");
  });

  it("прокидывает extraContext в промпт", async () => {
    const llm = new FakeLlmClient("ок");
    await new MarketAssessmentTool(llm).run({ stats: [], extraContext: "делистинг ABCUSDT" });
    expect(llm.lastPrompt!.user).toContain("делистинг ABCUSDT");
  });
});

describe("TradeReportTool", () => {
  const input = {
    runId: "run-x",
    startingDeposit: new Big("1000"),
    endingEquity: new Big("995.09"),
    tradeCount: 9,
    winCount: 1,
    fundingIncome: new Big("0.10"),
    basisPnl: new Big("-2.18"),
    fees: new Big("-2.75"),
    slippage: new Big("-0.08"),
    borrowCost: new Big("0"),
    exitBreakdown: [{ reason: "BASIS_DIVERGED", count: 4 }],
  };

  it("считает нетто, доходность, win-rate и главный источник убытка", async () => {
    const llm = new FakeLlmClient("Съели комиссии.");
    const result = await new TradeReportTool(llm).run(input);

    expect(result.data.netPnl.toFixed(2)).toBe("-4.91");
    expect(result.data.returnPct.toFixed(2)).toBe("-0.49");
    expect(result.data.winRatePct.toFixed(1)).toBe("11.1");
    expect(result.data.dominantLossDriver).toBe("комиссии"); // -2.75 самый отрицательный
    expect(llm.lastPrompt!.user).toContain("run-x");
    expect(llm.lastPrompt!.user).toContain("BASIS_DIVERGED: 4");
    expect(result.narrative).toBe("Съели комиссии.");
  });

  it("помечает отсутствие убыточного компонента, когда всё в плюсе", async () => {
    const profitable = {
      ...input,
      endingEquity: new Big("1010"),
      basisPnl: new Big("5"),
      fees: new Big("0"),
      slippage: new Big("0"),
    };
    const result = await new TradeReportTool(new FakeLlmClient("ок")).run(profitable);
    expect(result.data.dominantLossDriver).toBe("нет убыточного компонента");
  });
});

describe("computeOutlook / OpportunityOutlookTool", () => {
  it("помечает рынок торгуемым, когда есть возможность", () => {
    const o = computeOutlook(assessMarket([OPPORTUNITY]));
    expect(o.hasOpportunityNow).toBe(true);
    expect(o.distance).toBe("tradeable");
  });

  it("помечает 'близко', когда ликвидная пара в шаге по одному условию", () => {
    // NEAR_MISS_BASIS: 2.27 сигмы из 3 -> отставание (3-2.27)/3 = 0.24 < 0.4.
    const o = computeOutlook(assessMarket([NEAR_MISS_BASIS]));
    expect(o.hasOpportunityNow).toBe(false);
    expect(o.distance).toBe("close");
    expect(o.closest[0]!.symbol).toBe("WILDUSDT");
    expect(o.closest[0]!.reason).toBe("basis");
    expect(o.closest[0]!.sigmaShortfall!.toFixed(2)).toBe("0.73");
  });

  it("считает недостачу funding для near-miss по ставке", () => {
    const o = computeOutlook(assessMarket([NEAR_MISS_FUNDING]));
    expect(o.closest[0]!.reason).toBe("funding");
    // 0.0005 - 0.0004 = 0.0001 -> 0.010%/8ч
    expect(o.closest[0]!.fundingShortfallPct!.toFixed(3)).toBe("0.010");
  });

  it("возвращает 'далёк', когда ликвидных пар нет вовсе", () => {
    const illiquid: SymbolMarketStat = { ...OPPORTUNITY, perpTurnover24h: new Big("1000000") };
    const o = computeOutlook(assessMarket([illiquid]));
    expect(o.liquidCandidates).toBe(0);
    expect(o.distance).toBe("far");
  });

  it("инструмент возвращает и данные, и резюме", async () => {
    const result = await new OpportunityOutlookTool(new FakeLlmClient("Пока рано.")).run(
      assessMarket([NEAR_MISS_BASIS]),
    );
    expect(result.data.distance).toBe("close");
    expect(result.narrative).toBe("Пока рано.");
  });
});

describe("ToolRegistry / buildToolset", () => {
  it("собирает набор с типобезопасным доступом и манифестом из трёх инструментов", () => {
    const ts = buildToolset(new FakeLlmClient("ок"));
    expect(ts.marketAssessment.name).toBe("market_assessment");
    expect(ts.tradeReport.name).toBe("trade_report_analysis");
    expect(ts.opportunityOutlook.name).toBe("opportunity_outlook");
    const manifest = ts.registry.manifest();
    expect(manifest).toHaveLength(3);
    expect(ts.registry.get("market_assessment")).toBe(ts.marketAssessment);
  });

  it("запрещает двойную регистрацию под одним именем", () => {
    const reg = new ToolRegistry();
    const tool = new MarketAssessmentTool(new FakeLlmClient("ок"));
    reg.register(tool);
    expect(() => reg.register(tool)).toThrow(/уже зарегистрирован/);
  });
});
