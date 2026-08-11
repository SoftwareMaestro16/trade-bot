import Big from "big.js";
import { describe, expect, it } from "vitest";
import { evaluateScan } from "../../src/analysis/scanAlert.js";
import type { ScanState } from "../../src/analysis/scanAlert.js";
import { assessMarket } from "../../src/analysis/marketAssessment.js";
import type { SymbolMarketStat } from "../../src/analysis/marketAssessment.js";

const OPPORTUNITY: SymbolMarketStat = {
  symbol: "GOODUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.001"),
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.0001"),
};
// Ликвидная майор без funding — рынок непригоден (как сейчас в реальности).
const DEAD: SymbolMarketStat = {
  symbol: "BTCUSDT",
  perpTurnover24h: new Big("2500000000"),
  spotTurnover24h: new Big("300000000"),
  predictedR8h: new Big("0.0001"),
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.000067"),
};

const dead = assessMarket([DEAD]);
const oneOpp = assessMarket([OPPORTUNITY]);
const twoOpp = assessMarket([OPPORTUNITY, { ...OPPORTUNITY, symbol: "GOOD2USDT" }]);

describe("evaluateScan — анти-спам", () => {
  it("на холодном старте в мёртвом рынке не алертит", () => {
    const d = evaluateScan(dead, null);
    expect(d.alert).toBe(false);
    expect(d.newState).toEqual({ suitability: "unsuitable", opportunityCount: 0 });
  });

  it("алертит при ВХОДЕ в зону возможностей (мёртвый -> есть возможность)", () => {
    const prev: ScanState = { suitability: "unsuitable", opportunityCount: 0 };
    const d = evaluateScan(oneOpp, prev);
    expect(d.alert).toBe(true);
    expect(d.message).toContain("🟢");
    expect(d.message).toContain("GOODUSDT");
  });

  it("НЕ повторяет алерт, пока рынок остаётся в той же зоне", () => {
    const prev: ScanState = { suitability: oneOpp.suitability, opportunityCount: 1 };
    expect(evaluateScan(oneOpp, prev).alert).toBe(false);
  });

  it("алертит снова, когда шанс стал КРУПНЕЕ (больше возможностей)", () => {
    const prev: ScanState = { suitability: oneOpp.suitability, opportunityCount: 1 };
    const d = evaluateScan(twoOpp, prev);
    expect(d.alert).toBe(true);
    expect(d.newState.opportunityCount).toBe(2);
  });

  it("молчит при ухудшении (возможности пропали)", () => {
    const prev: ScanState = { suitability: oneOpp.suitability, opportunityCount: 1 };
    expect(evaluateScan(dead, prev).alert).toBe(false);
  });

  it("после ухода из зоны и возврата — алертит заново", () => {
    // была возможность -> пропала -> появилась снова
    const s1 = evaluateScan(oneOpp, { suitability: "unsuitable", opportunityCount: 0 });
    expect(s1.alert).toBe(true);
    const s2 = evaluateScan(dead, s1.newState);
    expect(s2.alert).toBe(false);
    const s3 = evaluateScan(oneOpp, s2.newState);
    expect(s3.alert).toBe(true); // новый шанс
  });

  it("marginal сам по себе не будит (только favorable+ или реальная возможность)", () => {
    // Собираем оценку со score в marginal-диапазоне без возможностей — сложно
    // без реального набора, поэтому проверяем правило напрямую через состояние:
    // переход unsuitable -> marginal не должен алертить.
    const prev: ScanState = { suitability: "unsuitable", opportunityCount: 0 };
    const marginalNoOpp = { ...dead, suitability: "marginal" as const, suitabilityScore: 10 };
    expect(evaluateScan(marginalNoOpp, prev).alert).toBe(false);
  });
});
