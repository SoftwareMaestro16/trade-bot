import { describe, expect, it } from "vitest";
import { FallbackLlmClient, LlmError } from "../../../src/analysis/llm/client.js";
import type { LlmClient, LlmPrompt } from "../../../src/analysis/llm/client.js";
import { checkLlmHealth, formatHealthReport } from "../../../src/analysis/llm/health.js";
import { modelsFor, buildHealthTargets } from "../../../src/analysis/llm/factory.js";
import { DEFAULT_LLM_MODEL, FALLBACK_LLM_MODEL } from "../../../src/analysis/llm/client.js";

const PROMPT: LlmPrompt = { system: "s", user: "u" };

class OkClient implements LlmClient {
  calls = 0;
  constructor(private readonly reply: string) {}
  complete(): Promise<string> {
    this.calls++;
    return Promise.resolve(this.reply);
  }
}
class FailClient implements LlmClient {
  calls = 0;
  constructor(private readonly err: Error = new LlmError("HTTP 503", 503)) {}
  complete(): Promise<string> {
    this.calls++;
    return Promise.reject(this.err);
  }
}

describe("FallbackLlmClient", () => {
  it("отдаёт ответ первого клиента, не трогая остальных", async () => {
    const first = new OkClient("основная");
    const second = new OkClient("резерв");
    const out = await new FallbackLlmClient([first, second]).complete(PROMPT);
    expect(out).toBe("основная");
    expect(second.calls).toBe(0);
  });

  it("падает на резерв, когда основная бросает LlmError, и зовёт onFallback", async () => {
    const first = new FailClient();
    const second = new OkClient("резерв");
    let notifiedIndex = -1;
    const client = new FallbackLlmClient([first, second], (i) => {
      notifiedIndex = i;
    });
    expect(await client.complete(PROMPT)).toBe("резерв");
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(notifiedIndex).toBe(0);
  });

  it("бросает последнюю ошибку, когда упали все", async () => {
    const client = new FallbackLlmClient([new FailClient(new LlmError("A")), new FailClient(new LlmError("B"))]);
    await expect(client.complete(PROMPT)).rejects.toMatchObject({ name: "LlmError", message: "B" });
  });

  it("НЕ перебирает на не-LlmError (баг в коде пробрасывается сразу)", async () => {
    const bug = new FailClient(new TypeError("boom"));
    const backup = new OkClient("резерв");
    await expect(new FallbackLlmClient([bug, backup]).complete(PROMPT)).rejects.toBeInstanceOf(TypeError);
    expect(backup.calls).toBe(0);
  });

  it("не создаётся из пустого списка", () => {
    expect(() => new FallbackLlmClient([])).toThrow(/хотя бы одного/);
  });
});

describe("checkLlmHealth / formatHealthReport", () => {
  it("сообщает ok и задержку для живой модели, инъектируя часы", async () => {
    let t = 1000;
    const clock = () => {
      const v = t;
      t += 42; // каждый вызов часов сдвигает на 42 мс
      return v;
    };
    const results = await checkLlmHealth([{ label: "nvidia", client: new OkClient("ок") }], clock);
    expect(results[0]).toMatchObject({ label: "nvidia", ok: true, latencyMs: 42, error: null });
  });

  it("сообщает недоступность с причиной, но НЕ бросает", async () => {
    const results = await checkLlmHealth([
      { label: "nvidia", client: new FailClient(new LlmError("HTTP 429: rate limit", 429)) },
      { label: "ling", client: new OkClient("ок") },
    ]);
    expect(results[0]).toMatchObject({ label: "nvidia", ok: false, error: "HTTP 429: rate limit" });
    expect(results[1]!.ok).toBe(true);
  });

  it("форматирует отчёт: заголовок отражает, есть ли хоть одна живая модель", async () => {
    const up = formatHealthReport([
      { label: "nvidia", ok: false, latencyMs: null, error: "лимит" },
      { label: "ling", ok: true, latencyMs: 100, error: null },
    ]);
    expect(up).toContain("🤖 LLM доступен:");
    expect(up).toContain("❌ nvidia");
    expect(up).toContain("✅ ling");

    const down = formatHealthReport([{ label: "nvidia", ok: false, latencyMs: null, error: "лимит" }]);
    expect(down).toContain("🤖 LLM недоступен:");
  });

  it("сообщает про отсутствие ключа на пустом списке", () => {
    expect(formatHealthReport([])).toContain("нет ключа");
  });
});

describe("factory — порядок и дедупликация моделей", () => {
  it("по умолчанию основная + резервная", () => {
    expect(modelsFor({ apiKey: "k" })).toEqual([DEFAULT_LLM_MODEL, FALLBACK_LLM_MODEL]);
  });

  it("уважает переопределение основной модели", () => {
    expect(modelsFor({ apiKey: "k", primaryModel: "x/y" })).toEqual(["x/y", FALLBACK_LLM_MODEL]);
  });

  it("не дублирует, если основная и есть резервная", () => {
    expect(modelsFor({ apiKey: "k", primaryModel: FALLBACK_LLM_MODEL })).toEqual([FALLBACK_LLM_MODEL]);
  });

  it("buildHealthTargets даёт по цели на каждую модель", () => {
    const targets = buildHealthTargets({ apiKey: "k" });
    expect(targets.map((t) => t.label)).toEqual([DEFAULT_LLM_MODEL, FALLBACK_LLM_MODEL]);
  });
});
