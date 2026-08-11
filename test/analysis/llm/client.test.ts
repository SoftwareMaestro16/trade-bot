import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import { OpenRouterClient, LlmError, DEFAULT_LLM_MODEL, stripReasoningBlocks } from "../../../src/analysis/llm/client.js";
import type { LlmPrompt } from "../../../src/analysis/llm/client.js";

const LLM_HOST = "https://openrouter.ai";
const LLM_PATH = "/api/v1/chat/completions";
// Броский, чтобы утечка ключа в ошибку была очевидна в проверках.
const FAKE_KEY = "sk-or-FAKE_SECRET_KEY_XYZ";

const PROMPT: LlmPrompt = { system: "s", user: "u" };

function client(overrides = {}) {
  return new OpenRouterClient({ apiKey: FAKE_KEY, requestTimeoutMs: 500, ...overrides });
}

afterEach(() => {
  nock.cleanAll();
});

describe("OpenRouterClient.complete", () => {
  it("возвращает обрезанный ответ и шлёт модель по умолчанию", async () => {
    let sentModel: string | undefined;
    nock(LLM_HOST)
      .post(LLM_PATH, (b: { model?: string }) => {
        sentModel = b.model;
        return true;
      })
      .reply(200, { choices: [{ message: { content: "  Рынок вялый.  " } }] });

    expect(await client().complete(PROMPT)).toBe("Рынок вялый.");
    expect(sentModel).toBe(DEFAULT_LLM_MODEL);
  });

  it("шлёт переопределённую модель", async () => {
    let sentModel: string | undefined;
    nock(LLM_HOST)
      .post(LLM_PATH, (b: { model?: string }) => {
        sentModel = b.model;
        return true;
      })
      .reply(200, { choices: [{ message: { content: "ок" } }] });

    await client({ model: "some/other-model" }).complete(PROMPT);
    expect(sentModel).toBe("some/other-model");
  });

  it("бросает LlmError на не-2xx, не раскрывая ключ", async () => {
    nock(LLM_HOST).post(LLM_PATH).reply(429, { error: { message: "rate limited" } });
    try {
      await client().complete(PROMPT);
      expect.unreachable("должно было бросить");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      const err = e as LlmError;
      expect(err.httpStatus).toBe(429);
      expect(err.providerMessage).toBe("rate limited");
      const serialized = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
      expect(serialized).not.toContain(FAKE_KEY);
    }
  });

  it("бросает LlmError на пустой ответ", async () => {
    nock(LLM_HOST).post(LLM_PATH).reply(200, { choices: [{ message: { content: "   " } }] });
    await expect(client().complete(PROMPT)).rejects.toBeInstanceOf(LlmError);
  });

  it("бросает LlmError на не-JSON тело", async () => {
    nock(LLM_HOST).post(LLM_PATH).reply(200, "не json вовсе");
    await expect(client().complete(PROMPT)).rejects.toBeInstanceOf(LlmError);
  });

  it("бросает LlmError по таймауту, если эндпоинт завис", async () => {
    nock(LLM_HOST).post(LLM_PATH).delay(1500).reply(200, { choices: [{ message: { content: "поздно" } }] });
    await expect(client().complete(PROMPT)).rejects.toMatchObject({ name: "LlmError" });
  });

  it("вырезает <think>-блоки из ответа модели", async () => {
    nock(LLM_HOST)
      .post(LLM_PATH)
      .reply(200, { choices: [{ message: { content: "<think>долго думаю по-английски</think>\nРынок вялый." } }] });
    expect(await client().complete(PROMPT)).toBe("Рынок вялый.");
  });

  it("бросает LlmError, если после вырезания рассуждений не осталось ответа", async () => {
    nock(LLM_HOST)
      .post(LLM_PATH)
      .reply(200, { choices: [{ message: { content: "<think>только мысли, ответа нет</think>" } }] });
    await expect(client().complete(PROMPT)).rejects.toBeInstanceOf(LlmError);
  });

  it("шлёт reasoning.exclude, чтобы reasoning-модели не возвращали мысли", async () => {
    let sentReasoning: unknown;
    nock(LLM_HOST)
      .post(LLM_PATH, (b: { reasoning?: unknown }) => {
        sentReasoning = b.reasoning;
        return true;
      })
      .reply(200, { choices: [{ message: { content: "ок" } }] });
    await client().complete(PROMPT);
    expect(sentReasoning).toEqual({ exclude: true });
  });
});

describe("stripReasoningBlocks", () => {
  it("оставляет обычный текст нетронутым", () => {
    expect(stripReasoningBlocks("Рынок вялый.")).toBe("Рынок вялый.");
  });

  it("режет <think>, <thinking>, <reasoning> регистронезависимо", () => {
    expect(stripReasoningBlocks("<THINK>x</THINK>Ответ")).toBe("Ответ");
    expect(stripReasoningBlocks("<thinking>y</thinking>\n\nОтвет")).toBe("Ответ");
    expect(stripReasoningBlocks("<reasoning>z</reasoning> Ответ")).toBe("Ответ");
  });

  it("возвращает пустую строку, если весь текст был рассуждением", () => {
    expect(stripReasoningBlocks("<think>всё сюда</think>")).toBe("");
  });
});
