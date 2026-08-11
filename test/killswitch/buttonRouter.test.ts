import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { CLEARED_STATE } from "../../src/killswitch/haltState.js";
import type { HaltState } from "../../src/killswitch/haltState.js";
import { MENU_KEYBOARD, MENU_TEXT, routeCallbackQuery } from "../../src/killswitch/buttonRouter.js";
import type { ButtonRouterDeps } from "../../src/killswitch/buttonRouter.js";
import type { InFlightTracker } from "../../src/killswitch/inFlightPersists.js";

function makeLogger(): Logger {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

type MockedDeps = ButtonRouterDeps & {
  inFlightPersists: { track: ReturnType<typeof vi.fn> };
  applyAndPersist: ReturnType<typeof vi.fn>;
  sendStatusReport: ReturnType<typeof vi.fn>;
  sendHelp: ReturnType<typeof vi.fn>;
  sendMenu: ReturnType<typeof vi.fn>;
  manageAuthorizedUser: ReturnType<typeof vi.fn>;
  editMenuMessage: ReturnType<typeof vi.fn>;
  answerCallback: ReturnType<typeof vi.fn>;
  renderStatus: ReturnType<typeof vi.fn>;
  renderHelp: ReturnType<typeof vi.fn>;
  renderMarket: ReturnType<typeof vi.fn>;
  renderMarketLlm: ReturnType<typeof vi.fn>;
  checkLlm: ReturnType<typeof vi.fn>;
  logger: Logger;
};

function makeDeps(overrides?: Partial<ButtonRouterDeps>): MockedDeps {
  const state: HaltState = { ...CLEARED_STATE };
  const inFlightPersists = { track: vi.fn() } as unknown as InFlightTracker & { track: ReturnType<typeof vi.fn> };
  const deps = {
    getState: () => state,
    inFlightPersists,
    applyAndPersist: vi.fn().mockResolvedValue(undefined),
    sendStatusReport: vi.fn().mockResolvedValue(undefined),
    sendHelp: vi.fn().mockResolvedValue(undefined),
    sendMenu: vi.fn().mockResolvedValue(undefined),
    manageAuthorizedUser: vi.fn().mockResolvedValue(undefined),
    telegramConfig: null,
    logger: makeLogger(),
    editMenuMessage: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
    renderStatus: vi.fn().mockResolvedValue("СТАТУС-HTML"),
    renderHelp: vi.fn().mockResolvedValue("ПОМОЩЬ-HTML"),
    renderMarket: vi.fn().mockResolvedValue("РЫНОК-ТЕКСТ"),
    renderMarketLlm: vi.fn().mockResolvedValue("РЫНОК+LLM"),
    checkLlm: vi.fn().mockResolvedValue("LLM-ЗДОРОВЬЕ"),
    ...overrides,
  };
  return deps as unknown as MockedDeps;
}

const CHAT_ID = "111111111";
const MESSAGE_ID = 42;
const CALLBACK_ID = "cbq-abc";

describe("routeCallbackQuery — навигация", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'menu': правит сообщение обратно в главное меню", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("menu", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, MENU_TEXT, MENU_KEYBOARD);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'manage': открывает подменю управления с кнопками Начать/Остановить/Закрыть всё", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("manage", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    const [, text, keyboard] = deps.editMenuMessage.mock.calls[0] as [number, string, { inlineKeyboard: { callbackData: string }[][] }];
    expect(text).toContain("Управление");
    const datas = keyboard.inlineKeyboard.flat().map((b) => b.callbackData);
    expect(datas).toEqual(["resume", "stop_confirm", "flatten_confirm", "menu"]);
  });
});

describe("routeCallbackQuery — kill switch (без изменений поведения)", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'status': показывает renderStatus в меню (editMessage, HTML), не шлёт новое сообщение", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("status", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.sendStatusReport).not.toHaveBeenCalled(); // больше НЕ новое сообщение
    expect(deps.renderStatus).toHaveBeenCalledTimes(1);
    const calls = deps.editMenuMessage.mock.calls as [number, string, unknown, string | undefined][];
    expect(calls[calls.length - 1]![1]).toBe("СТАТУС-HTML");
    expect(calls[calls.length - 1]![3]).toBe("HTML"); // parseMode
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'help': показывает renderHelp в меню (editMessage, HTML)", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("help", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.sendHelp).not.toHaveBeenCalled();
    expect(deps.renderHelp).toHaveBeenCalledTimes(1);
    const calls = deps.editMenuMessage.mock.calls as [number, string, unknown, string | undefined][];
    expect(calls[calls.length - 1]![1]).toBe("ПОМОЩЬ-HTML");
    expect(calls[calls.length - 1]![3]).toBe("HTML");
  });

  it("'resume': снимает halt через applyAndPersist и правит на подтверждение с тостом", () => {
    const deps = makeDeps();
    void routeCallbackQuery("resume", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(CLEARED_STATE, expect.stringContaining("Halt cleared via /resume"));
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, expect.stringContaining("запущена"), expect.anything());
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Запущено");
  });

  it("'stop_confirm': НЕ трогает applyAndPersist — только правит на предупреждение + confirm-клавиатуру", () => {
    const deps = makeDeps();
    void routeCallbackQuery("stop_confirm", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    const [messageId, text, keyboard] = deps.editMenuMessage.mock.calls[0] as [number, string, { inlineKeyboard: unknown[][] }];
    expect(messageId).toBe(MESSAGE_ID);
    expect(text).toContain("HALT_NEW");
    expect(keyboard.inlineKeyboard[0]).toEqual([
      { text: "Да, остановить", callbackData: "stop_execute" },
      { text: "Отмена", callbackData: "cancel" },
    ]);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'flatten_confirm': НЕ трогает applyAndPersist — только правит на предупреждение + confirm", () => {
    const deps = makeDeps();
    void routeCallbackQuery("flatten_confirm", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    const [, text, keyboard] = deps.editMenuMessage.mock.calls[0] as [number, string, { inlineKeyboard: unknown[][] }];
    expect(text).toContain("FLATTEN_ALL");
    expect(keyboard.inlineKeyboard[0]).toEqual([
      { text: "Да, закрыть всё", callbackData: "flatten_execute" },
      { text: "Отмена", callbackData: "cancel" },
    ]);
  });

  it("'stop_execute': реально поднимает HALT_NEW и чистит кнопки", () => {
    const deps = makeDeps();
    void routeCallbackQuery("stop_execute", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ haltNew: true, flattenAll: false }),
      expect.stringContaining("HALT_NEW"),
    );
    expect(deps.inFlightPersists.track).toHaveBeenCalledTimes(1);
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, expect.stringContaining("HALT_NEW"), { inlineKeyboard: [] });
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Остановлено");
  });

  it("'flatten_execute': реально поднимает FLATTEN_ALL и чистит кнопки", () => {
    const deps = makeDeps();
    void routeCallbackQuery("flatten_execute", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ haltNew: true, flattenAll: true }),
      expect.stringContaining("FLATTEN_ALL"),
    );
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, expect.stringContaining("FLATTEN_ALL"), { inlineKeyboard: [] });
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Flatten активирован");
  });

  it("'cancel': НЕ трогает applyAndPersist — возвращает сообщение в главное меню", () => {
    const deps = makeDeps();
    void routeCallbackQuery("cancel", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, MENU_TEXT, MENU_KEYBOARD);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Отменено");
  });

  it("неизвестный callback_data: логируется, кроме ответа на callback — без побочек", () => {
    const deps = makeDeps();
    void routeCallbackQuery("bogus", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.logger.info).toHaveBeenCalledWith({ data: "bogus" }, "unrecognized callback_data");
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.editMenuMessage).not.toHaveBeenCalled();
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });
});

describe("routeCallbackQuery — async-разделы (Рынок/LLM)", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'market': сперва «⏳», затем результат renderMarket, с клавиатурой рынка", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("market", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.renderMarket).toHaveBeenCalledTimes(1);
    // Первый edit — загрузка, второй — результат.
    const calls = deps.editMenuMessage.mock.calls as [number, string, { inlineKeyboard: { callbackData: string }[][] }][];
    expect(calls[0]![1]).toContain("⏳");
    expect(calls[1]![1]).toBe("РЫНОК-ТЕКСТ");
    expect(calls[1]![2].inlineKeyboard.flat().map((b) => b.callbackData)).toContain("market_llm");
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'market_llm': показывает результат renderMarketLlm", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("market_llm", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.renderMarketLlm).toHaveBeenCalledTimes(1);
    const calls = deps.editMenuMessage.mock.calls as [number, string, unknown][];
    expect(calls[calls.length - 1]![1]).toBe("РЫНОК+LLM");
  });

  it("'llm_health': показывает результат checkLlm с клавиатурой LLM", async () => {
    const deps = makeDeps();
    await routeCallbackQuery("llm_health", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.checkLlm).toHaveBeenCalledTimes(1);
    const calls = deps.editMenuMessage.mock.calls as [number, string, { inlineKeyboard: { callbackData: string }[][] }][];
    expect(calls[calls.length - 1]![1]).toBe("LLM-ЗДОРОВЬЕ");
    expect(calls[calls.length - 1]![2].inlineKeyboard.flat().map((b) => b.callbackData)).toContain("llm_health");
  });

  it("если render бросил — показывает текст ошибки, а не виснет на «⏳»", async () => {
    const deps = makeDeps({ renderMarket: vi.fn().mockRejectedValue(new Error("db down")) });
    await routeCallbackQuery("market", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    const calls = deps.editMenuMessage.mock.calls as [number, string, unknown][];
    expect(calls[calls.length - 1]![1]).toContain("Не удалось");
  });
});
