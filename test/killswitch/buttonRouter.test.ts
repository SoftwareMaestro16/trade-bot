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

function makeDeps(overrides?: Partial<ButtonRouterDeps>): ButtonRouterDeps & {
  inFlightPersists: { track: ReturnType<typeof vi.fn> };
  applyAndPersist: ReturnType<typeof vi.fn>;
  sendStatusReport: ReturnType<typeof vi.fn>;
  sendHelp: ReturnType<typeof vi.fn>;
  sendMenu: ReturnType<typeof vi.fn>;
  manageAuthorizedUser: ReturnType<typeof vi.fn>;
  editMenuMessage: ReturnType<typeof vi.fn>;
  answerCallback: ReturnType<typeof vi.fn>;
  logger: Logger;
} {
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
    ...overrides,
  };
  return deps as typeof deps &
    ButtonRouterDeps & {
      inFlightPersists: { track: ReturnType<typeof vi.fn> };
      applyAndPersist: ReturnType<typeof vi.fn>;
      sendStatusReport: ReturnType<typeof vi.fn>;
      sendHelp: ReturnType<typeof vi.fn>;
      sendMenu: ReturnType<typeof vi.fn>;
      manageAuthorizedUser: ReturnType<typeof vi.fn>;
      editMenuMessage: ReturnType<typeof vi.fn>;
      answerCallback: ReturnType<typeof vi.fn>;
      logger: Logger;
    };
}

const CHAT_ID = "111111111";
const MESSAGE_ID = 42;
const CALLBACK_ID = "cbq-abc";

describe("routeCallbackQuery", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'status': delegates to routeAuthorizedCommand's sendStatusReport, then answers the callback with no toast", () => {
    const deps = makeDeps();
    routeCallbackQuery("status", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.sendStatusReport).toHaveBeenCalledTimes(1);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
    expect(deps.editMenuMessage).not.toHaveBeenCalled();
  });

  it("'help': delegates to sendHelp, then answers the callback", () => {
    const deps = makeDeps();
    routeCallbackQuery("help", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.sendHelp).toHaveBeenCalledTimes(1);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'resume': clears the halt via applyAndPersist (same as the typed /resume path), then answers the callback", () => {
    const deps = makeDeps();
    routeCallbackQuery("resume", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(CLEARED_STATE, expect.stringContaining("Halt cleared via /resume"));
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'stop_confirm': does NOT touch applyAndPersist — only edits the message to a warning + confirm keyboard", () => {
    const deps = makeDeps();
    routeCallbackQuery("stop_confirm", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.editMenuMessage).toHaveBeenCalledTimes(1);
    const [messageId, text, keyboard] = deps.editMenuMessage.mock.calls[0] as [number, string, { inlineKeyboard: unknown[][] }];
    expect(messageId).toBe(MESSAGE_ID);
    expect(text).toContain("HALT_NEW");
    expect(keyboard.inlineKeyboard[0]).toEqual([
      { text: "Да, остановить", callbackData: "stop_execute" },
      { text: "Отмена", callbackData: "cancel" },
    ]);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'flatten_confirm': does NOT touch applyAndPersist — only edits the message to a warning + confirm keyboard", () => {
    const deps = makeDeps();
    routeCallbackQuery("flatten_confirm", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.editMenuMessage).toHaveBeenCalledTimes(1);
    const [, text, keyboard] = deps.editMenuMessage.mock.calls[0] as [number, string, { inlineKeyboard: unknown[][] }];
    expect(text).toContain("FLATTEN_ALL");
    expect(keyboard.inlineKeyboard[0]).toEqual([
      { text: "Да, закрыть всё", callbackData: "flatten_execute" },
      { text: "Отмена", callbackData: "cancel" },
    ]);
  });

  it("'stop_execute': actually raises HALT_NEW via applyAndPersist, then clears the message's buttons", () => {
    const deps = makeDeps();
    routeCallbackQuery("stop_execute", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).toHaveBeenCalledTimes(1);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ haltNew: true, flattenAll: false }),
      expect.stringContaining("HALT_NEW"),
    );
    expect(deps.inFlightPersists.track).toHaveBeenCalledTimes(1);
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, expect.stringContaining("HALT_NEW"), { inlineKeyboard: [] });
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Остановлено");
  });

  it("'flatten_execute': actually raises FLATTEN_ALL via applyAndPersist, then clears the message's buttons", () => {
    const deps = makeDeps();
    routeCallbackQuery("flatten_execute", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).toHaveBeenCalledTimes(1);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ haltNew: true, flattenAll: true }),
      expect.stringContaining("FLATTEN_ALL"),
    );
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, expect.stringContaining("FLATTEN_ALL"), { inlineKeyboard: [] });
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Flatten активирован");
  });

  it("'cancel': does NOT touch applyAndPersist — reverts the message back to the main menu", () => {
    const deps = makeDeps();
    routeCallbackQuery("cancel", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.editMenuMessage).toHaveBeenCalledWith(MESSAGE_ID, MENU_TEXT, MENU_KEYBOARD);
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID, "Отменено");
  });

  it("unrecognized callback_data: logged, no dependency side effects beyond answering the callback", () => {
    const deps = makeDeps();
    routeCallbackQuery("bogus", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.logger.info).toHaveBeenCalledWith({ data: "bogus" }, "unrecognized callback_data");
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.editMenuMessage).not.toHaveBeenCalled();
    expect(deps.answerCallback).toHaveBeenCalledWith(CALLBACK_ID);
  });

  it("'stop_execute' cannot be reached without going through 'stop_confirm' first in the router's own vocabulary — confirms the two-step design isn't bypassable by a single callback_data value alone", () => {
    // Not a real bypass test (routeCallbackQuery is stateless per call — the
    // real guarantee is that Telegram only ever sends back the callback_data
    // of a button that was actually rendered, and stop_execute is only ever
    // rendered by the stop_confirm case above) — this test just pins down
    // that 'stop_confirm' itself never calls applyAndPersist, which is the
    // property that makes the two-step flow meaningful at all.
    const deps = makeDeps();
    routeCallbackQuery("stop_confirm", CHAT_ID, MESSAGE_ID, CALLBACK_ID, deps);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
  });
});
