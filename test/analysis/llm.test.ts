import Big from "big.js";
import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import {
  chat,
  buildMarketSummaryPrompt,
  formatAssessmentFacts,
  summarizeMarket,
  LlmError,
  DEFAULT_LLM_MODEL,
} from "../../src/analysis/llm.js";
import type { LlmConfig } from "../../src/analysis/llm.js";
import { assessMarket } from "../../src/analysis/marketAssessment.js";
import type { SymbolMarketStat } from "../../src/analysis/marketAssessment.js";

const LLM_HOST = "https://openrouter.ai";
const LLM_PATH = "/api/v1/chat/completions";
// Eye-catching so any leak into an error is obvious in assertions.
const FAKE_KEY = "sk-or-FAKE_SECRET_KEY_XYZ";
const config: LlmConfig = { apiKey: FAKE_KEY, requestTimeoutMs: 500 };

const OPPORTUNITY: SymbolMarketStat = {
  symbol: "GOODUSDT",
  perpTurnover24h: new Big("200000000"),
  spotTurnover24h: new Big("50000000"),
  predictedR8h: new Big("0.001"),
  currentBasis: new Big("0"),
  basisStdDev: new Big("0.0001"),
};
const EMPTY = assessMarket([]);
const WITH_OPP = assessMarket([OPPORTUNITY]);

afterEach(() => {
  nock.cleanAll();
});

describe("formatAssessmentFacts — deterministic, only real numbers", () => {
  it("states the score and every bucket count", () => {
    const facts = formatAssessmentFacts(EMPTY);
    expect(facts).toContain("Оценка пригодности рынка: 0/100 (unsuitable)");
    expect(facts).toContain("проходящих ВСЕ три условия");
  });

  it("lists opportunities with their funding, sigma margin and ceiling", () => {
    const facts = formatAssessmentFacts(WITH_OPP);
    expect(facts).toContain("GOODUSDT");
    expect(facts).toContain("0.100%/8ч"); // 0.001 -> 0.100%
    expect(facts).toContain("5.85%/мес"); // ceiling
  });

  it("omits the opportunity list entirely when there are none", () => {
    expect(formatAssessmentFacts(EMPTY)).not.toContain("Возможности");
  });
});

describe("buildMarketSummaryPrompt — constrains the model", () => {
  it("system prompt forbids trading advice and invented numbers", () => {
    const { system } = buildMarketSummaryPrompt(EMPTY);
    expect(system).toContain("НЕ даёшь торговых советов");
    expect(system).toContain("ТОЛЬКО те числа");
  });

  it("appends extra context only when non-empty", () => {
    expect(buildMarketSummaryPrompt(EMPTY, "  ").user).not.toContain("Дополнительный контекст");
    expect(buildMarketSummaryPrompt(EMPTY, "делистинг ABCUSDT").user).toContain("делистинг ABCUSDT");
  });
});

describe("chat — network paths", () => {
  it("returns the trimmed completion on success and sends the configured model", async () => {
    let sentModel: string | undefined;
    nock(LLM_HOST)
      .post(LLM_PATH, (b: { model?: string }) => {
        sentModel = b.model;
        return true;
      })
      .reply(200, { choices: [{ message: { content: "  Рынок вялый.  " } }] });

    const out = await summarizeMarket(config, EMPTY);
    expect(out).toBe("Рынок вялый.");
    expect(sentModel).toBe(DEFAULT_LLM_MODEL);
  });

  it("throws LlmError on a non-2xx without leaking the api key", async () => {
    nock(LLM_HOST).post(LLM_PATH).reply(429, { error: { message: "rate limited" } });
    try {
      await summarizeMarket(config, EMPTY);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      const err = e as LlmError;
      expect(err.httpStatus).toBe(429);
      expect(err.providerMessage).toBe("rate limited");
      const serialized = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
      expect(serialized).not.toContain(FAKE_KEY);
    }
  });

  it("throws LlmError on an empty completion", async () => {
    nock(LLM_HOST).post(LLM_PATH).reply(200, { choices: [{ message: { content: "   " } }] });
    await expect(summarizeMarket(config, EMPTY)).rejects.toBeInstanceOf(LlmError);
  });

  it("throws LlmError on a malformed (non-JSON) body", async () => {
    nock(LLM_HOST).post(LLM_PATH).reply(200, "not json at all");
    await expect(summarizeMarket(config, EMPTY)).rejects.toBeInstanceOf(LlmError);
  });

  it("throws a timeout LlmError when the endpoint stalls past the deadline", async () => {
    nock(LLM_HOST)
      .post(LLM_PATH)
      .delay(1500)
      .reply(200, { choices: [{ message: { content: "too late" } }] });
    await expect(chat(config, buildMarketSummaryPrompt(EMPTY))).rejects.toMatchObject({
      name: "LlmError",
    });
  });
});
