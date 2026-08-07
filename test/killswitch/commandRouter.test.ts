import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { CLEARED_STATE } from "../../src/killswitch/haltState.js";
import type { HaltState } from "../../src/killswitch/haltState.js";
import { routeAuthorizedCommand } from "../../src/killswitch/commandRouter.js";
import type { CommandRouterDeps } from "../../src/killswitch/commandRouter.js";
import type { InFlightTracker } from "../../src/killswitch/inFlightPersists.js";
import type { TelegramConfig } from "../../src/notify/telegram.js";

function makeLogger(): Logger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

function makeDeps(overrides?: Partial<CommandRouterDeps>): CommandRouterDeps & {
  inFlightPersists: { track: ReturnType<typeof vi.fn> };
  applyAndPersist: ReturnType<typeof vi.fn>;
  sendStatusReport: ReturnType<typeof vi.fn>;
  manageAuthorizedUser: ReturnType<typeof vi.fn>;
  logger: Logger;
} {
  const state: HaltState = { ...CLEARED_STATE };
  const inFlightPersists = { track: vi.fn() } as unknown as InFlightTracker & { track: ReturnType<typeof vi.fn> };
  const deps = {
    getState: () => state,
    inFlightPersists,
    applyAndPersist: vi.fn().mockResolvedValue(undefined),
    sendStatusReport: vi.fn().mockResolvedValue(undefined),
    manageAuthorizedUser: vi.fn().mockResolvedValue(undefined),
    telegramConfig: null,
    logger: makeLogger(),
    ...overrides,
  };
  return deps as typeof deps &
    CommandRouterDeps & {
      inFlightPersists: { track: ReturnType<typeof vi.fn> };
      applyAndPersist: ReturnType<typeof vi.fn>;
      sendStatusReport: ReturnType<typeof vi.fn>;
      manageAuthorizedUser: ReturnType<typeof vi.fn>;
      logger: Logger;
    };
}

const ROOT_ADMIN = "111111111";
const OTHER_AUTHORIZED = "222222222";

function makeTelegramConfig(): TelegramConfig {
  return { botToken: "test-token", allowedChatId: ROOT_ADMIN };
}

describe("routeAuthorizedCommand", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/stop: raises HALT_NEW via applyAndPersist, tracked as in-flight", () => {
    const deps = makeDeps();

    routeAuthorizedCommand("stop", [], ROOT_ADMIN, deps);

    expect(deps.applyAndPersist).toHaveBeenCalledTimes(1);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      { haltNew: true, flattenAll: false, reason: "manual /stop", setBy: "telegram", setAtMs: 1_700_000_000_000 },
      "🛑 <b>HALT_NEW</b> — new entries blocked via /stop",
    );
    expect(deps.inFlightPersists.track).toHaveBeenCalledTimes(1);
    expect(deps.inFlightPersists.track).toHaveBeenCalledWith(deps.applyAndPersist.mock.results[0]?.value);
  });

  it("/flatten: raises FLATTEN_ALL via applyAndPersist, tracked as in-flight", () => {
    const deps = makeDeps();

    routeAuthorizedCommand("flatten", [], ROOT_ADMIN, deps);

    expect(deps.applyAndPersist).toHaveBeenCalledTimes(1);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      { haltNew: true, flattenAll: true, reason: "manual /flatten", setBy: "telegram", setAtMs: 1_700_000_000_000 },
      "🛑 <b>FLATTEN_ALL</b> — new entries blocked, closing everything, via /flatten " +
        "(no execution/ order placement exists yet — this raises the flag for when it does)",
    );
    expect(deps.inFlightPersists.track).toHaveBeenCalledTimes(1);
  });

  it("/resume: clears the halt, attributing confirmedBy to the joined args", () => {
    const deps = makeDeps();

    routeAuthorizedCommand("resume", ["operator-name"], ROOT_ADMIN, deps);

    expect(deps.applyAndPersist).toHaveBeenCalledTimes(1);
    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      CLEARED_STATE,
      "✅ Halt cleared via /resume (confirmed by telegram:operator-name)",
    );
    expect(deps.inFlightPersists.track).toHaveBeenCalledTimes(1);
  });

  it("/resume: falls back to 'operator' as confirmedBy when no args are given", () => {
    const deps = makeDeps();

    routeAuthorizedCommand("resume", [], ROOT_ADMIN, deps);

    expect(deps.applyAndPersist).toHaveBeenCalledWith(
      CLEARED_STATE,
      "✅ Halt cleared via /resume (confirmed by telegram:operator)",
    );
  });

  it("/status: delegates to sendStatusReport and does not touch applyAndPersist", () => {
    const deps = makeDeps();

    routeAuthorizedCommand("status", [], ROOT_ADMIN, deps);

    expect(deps.sendStatusReport).toHaveBeenCalledTimes(1);
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.inFlightPersists.track).not.toHaveBeenCalled();
  });

  it("/add: rejects (logged, no reply) when Telegram is not configured", () => {
    const deps = makeDeps({ telegramConfig: null });

    routeAuthorizedCommand("add", ["333333333"], ROOT_ADMIN, deps);

    expect(deps.logger.error).toHaveBeenCalledWith(
      { chatId: ROOT_ADMIN, command: "add", args: ["333333333"] },
      "REJECTED /add — Telegram is not configured",
    );
    expect(deps.manageAuthorizedUser).not.toHaveBeenCalled();
  });

  it("/add: rejects (logged, no reply) when the sender is not the root admin", () => {
    const telegramConfig = makeTelegramConfig();
    const deps = makeDeps({ telegramConfig });

    routeAuthorizedCommand("add", ["333333333"], OTHER_AUTHORIZED, deps);

    expect(deps.logger.error).toHaveBeenCalledWith(
      { chatId: OTHER_AUTHORIZED, command: "add", args: ["333333333"] },
      "REJECTED /add — only the root admin chat_id may manage authorized_users",
    );
    expect(deps.manageAuthorizedUser).not.toHaveBeenCalled();
  });

  it("/add: delegates to manageAuthorizedUser when the sender IS the root admin", () => {
    const telegramConfig = makeTelegramConfig();
    const deps = makeDeps({ telegramConfig });

    routeAuthorizedCommand("add", ["333333333"], ROOT_ADMIN, deps);

    expect(deps.manageAuthorizedUser).toHaveBeenCalledWith("add", "333333333", ROOT_ADMIN, ROOT_ADMIN);
  });

  it("/delete: rejects (logged, no reply) when the sender is not the root admin", () => {
    const telegramConfig = makeTelegramConfig();
    const deps = makeDeps({ telegramConfig });

    routeAuthorizedCommand("delete", ["333333333"], OTHER_AUTHORIZED, deps);

    expect(deps.logger.error).toHaveBeenCalledWith(
      { chatId: OTHER_AUTHORIZED, command: "delete", args: ["333333333"] },
      "REJECTED /delete — only the root admin chat_id may manage authorized_users",
    );
    expect(deps.manageAuthorizedUser).not.toHaveBeenCalled();
  });

  it("/delete: delegates to manageAuthorizedUser when the sender IS the root admin", () => {
    const telegramConfig = makeTelegramConfig();
    const deps = makeDeps({ telegramConfig });

    routeAuthorizedCommand("delete", ["333333333"], ROOT_ADMIN, deps);

    expect(deps.manageAuthorizedUser).toHaveBeenCalledWith("delete", "333333333", ROOT_ADMIN, ROOT_ADMIN);
  });

  it("unrecognized command: logged, no dependency side effects", () => {
    const deps = makeDeps();

    routeAuthorizedCommand("bogus", [], ROOT_ADMIN, deps);

    expect(deps.logger.info).toHaveBeenCalledWith({ command: "bogus" }, "unrecognized command");
    expect(deps.applyAndPersist).not.toHaveBeenCalled();
    expect(deps.sendStatusReport).not.toHaveBeenCalled();
    expect(deps.manageAuthorizedUser).not.toHaveBeenCalled();
    expect(deps.inFlightPersists.track).not.toHaveBeenCalled();
  });
});
