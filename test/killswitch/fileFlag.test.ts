import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFlagPresent, selfTestFileFlag, startFileFlagWatcher } from "../../src/killswitch/fileFlag.js";

// Unique per test (crypto.randomUUID), not a single hardcoded path — tests in
// this file run concurrently with each other and with other test files, and
// must not collide over the same file on disk.
function uniqueFlagPath(): string {
  return join(tmpdir(), `trade-bot-fileflag-test-${randomUUID()}.flag`);
}

describe("isFlagPresent", () => {
  let flagPath: string;

  beforeEach(() => {
    flagPath = uniqueFlagPath();
  });

  afterEach(async () => {
    await rm(flagPath, { force: true });
  });

  it("is false for a file that does not exist", () => {
    expect(isFlagPresent(flagPath)).toBe(false);
  });

  it("is true for a file that exists", async () => {
    await writeFile(flagPath, "");
    expect(isFlagPresent(flagPath)).toBe(true);
  });
});

describe("selfTestFileFlag", () => {
  let flagPath: string;

  beforeEach(() => {
    flagPath = uniqueFlagPath();
  });

  afterEach(async () => {
    await rm(flagPath, { force: true });
  });

  it("returns true under normal conditions on a fresh temp path", async () => {
    await expect(selfTestFileFlag(flagPath)).resolves.toBe(true);
  });

  it("leaves no file behind on disk after a successful self-test", async () => {
    await selfTestFileFlag(flagPath);
    expect(isFlagPresent(flagPath)).toBe(false);
  });

  it("TEST-CASES.md #42: returns false when the flag directory itself can't be written to — the real fs failure this covers is a nonexistent/unwritable parent dir, same as a read-only-remounted one for this function's purposes (its own doc comment: 'ENOENT на родительский каталог, EACCES и т.п.' both require the same false result)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unwritablePath = join(tmpdir(), `trade-bot-fileflag-test-${randomUUID()}`, "nested", "KILLSWITCH_STOP");

    await expect(selfTestFileFlag(unwritablePath)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
    // Genuinely never touched disk — not just "returned false, might have partially written."
    expect(isFlagPresent(unwritablePath)).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("returns false and does not delete a file that already existed before the call", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(flagPath, "pre-existing content, not this module's to touch");

    await expect(selfTestFileFlag(flagPath)).resolves.toBe(false);

    // The pre-existing file must still be there — a false result here must
    // never come at the cost of silently deleting someone else's file.
    expect(isFlagPresent(flagPath)).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});

describe("startFileFlagWatcher", () => {
  let flagPath: string;

  beforeEach(() => {
    flagPath = uniqueFlagPath();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(flagPath, { force: true });
  });

  it("wasPresentAtStart reflects disk state from the SAME read used to seed the watcher's baseline — true when the flag already exists, false otherwise", async () => {
    const absent = startFileFlagWatcher({ flagFilePath: flagPath, pollIntervalMs: 100 }, vi.fn());
    expect(absent.wasPresentAtStart).toBe(false);
    absent.stop();

    await writeFile(flagPath, "");
    const present = startFileFlagWatcher({ flagFilePath: flagPath, pollIntervalMs: 100 }, vi.fn());
    expect(present.wasPresentAtStart).toBe(true);
    present.stop();
  });

  it("calls onFlagDetected exactly once on the absence-to-presence transition, and not again on later ticks while the flag is still present", async () => {
    const onFlagDetected = vi.fn();
    const watcher = startFileFlagWatcher({ flagFilePath: flagPath, pollIntervalMs: 100 }, onFlagDetected);

    // The flag is created only AFTER the watcher has already started —
    // exercising the edge-triggered detection itself, not a pre-existing file.
    await writeFile(flagPath, "");

    await vi.advanceTimersByTimeAsync(100); // first poll to observe the flag
    expect(onFlagDetected).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100 * 5); // several more polls, flag still on disk
    expect(onFlagDetected).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("survives onFlagDetected throwing, logs it, keeps polling for a fresh transition, and stop() halts further checks", async () => {
    const boom = new Error("handler blew up");
    const onFlagDetected = vi.fn(() => {
      throw boom;
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const watcher = startFileFlagWatcher({ flagFilePath: flagPath, pollIntervalMs: 100 }, onFlagDetected);

    await writeFile(flagPath, "");
    await vi.advanceTimersByTimeAsync(100);
    expect(onFlagDetected).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(flagPath), boom);

    // Remove and recreate the flag: a fresh absence-to-presence transition.
    // The watcher must still be polling after the handler's exception above.
    await rm(flagPath, { force: true });
    await vi.advanceTimersByTimeAsync(100); // observes the absence, resets the edge
    await writeFile(flagPath, "");
    await vi.advanceTimersByTimeAsync(100); // observes the new transition

    expect(onFlagDetected).toHaveBeenCalledTimes(2);

    watcher.stop();

    // After stop(), repeat the same remove/recreate cycle and confirm no
    // further calls happen — stop() actually halts the polling, it doesn't
    // just coincidentally line up with the assertions above.
    await rm(flagPath, { force: true });
    await vi.advanceTimersByTimeAsync(100);
    await writeFile(flagPath, "");
    await vi.advanceTimersByTimeAsync(100 * 3);

    expect(onFlagDetected).toHaveBeenCalledTimes(2);
  });
});
