import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFlagPresent, selfTestFileFlag, startFileFlagWatcher } from "../../src/killswitch/fileFlag.js";

// `existsSyncMock` backs a partial mock of "node:fs" used ONLY by the two
// selfTestFileFlag tests below that force the post-write/post-delete
// defensive branches (see that describe block). Its default implementation
// is a transparent passthrough to the real `existsSync` — every other test
// in this file (including isFlagPresent and startFileFlagWatcher) drives it
// through real disk state exactly as before; only the two tests that call
// `existsSyncMock.mockReturnValueOnce(...)` see a forced value, and only for
// the one call each `.mockReturnValueOnce` covers.
//
// The passthrough is re-armed in a file-level `beforeEach` (below), not set
// once inside the vi.mock factory: `startFileFlagWatcher`'s own describe
// block calls `vi.restoreAllMocks()` in its afterEach, which — since
// `existsSyncMock` is a bare `vi.fn()` with no vi.spyOn original to restore
// to — degrades to a full reset and wipes any implementation set only once.
// Re-arming before every test makes this mock's baseline immune to whatever
// other describe blocks in this file do with mock-management APIs.
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => existsSyncMock(...args) as boolean,
  };
});

let realExistsSync: (typeof import("node:fs"))["existsSync"];

beforeEach(async () => {
  realExistsSync ??= (await vi.importActual<typeof import("node:fs")>("node:fs")).existsSync;
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation(realExistsSync);
});

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

  // The next two tests exercise the defensive isFlagPresent-still-false (post-write)
  // and isFlagPresent-still-true (post-delete) branches. Neither is reachable via
  // real fs behavior on a normal filesystem — a successful writeFile is always
  // immediately visible to existsSync, and likewise for unlink — which is exactly
  // why these are the two branches TEST-CASES.md/the STLC audit flagged as
  // unexercised: they only guard against a broken isFlagPresent/write/unlink
  // implementation, e.g. an inverted comparison introduced by a future edit. The
  // real writeFile/unlink still run for real against `flagPath` in both tests —
  // only the module's own `existsSync` read (via the "node:fs" partial mock
  // installed at the top of this file) is forced to the anomalous value for the
  // one call under test, so the scenario is "write/delete genuinely succeeded,
  // but isFlagPresent disagrees" rather than a simulated fs failure.
  it("returns false when isFlagPresent still reports false immediately after a successful write (RISK-REGISTER FM-34: this is what gates whether the bot is allowed to start trading)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    existsSyncMock
      .mockReturnValueOnce(false) // pre-write check (real: flagPath is fresh, not yet written)
      .mockReturnValueOnce(false); // post-write check: forced anomaly under test

    await expect(selfTestFileFlag(flagPath)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("write did not have the expected effect"),
    );
    // The real writeFile() genuinely ran (only isFlagPresent's own read was
    // forced) and the function returned before ever reaching unlink() — this
    // call goes through the mock's default passthrough (its once-queue is
    // exhausted), reflecting real disk state: the file really is still there.
    expect(isFlagPresent(flagPath)).toBe(true);

    consoleErrorSpy.mockRestore();
  });

  it("returns false when isFlagPresent still reports true immediately after a successful delete (RISK-REGISTER FM-34: this is what gates whether the bot is allowed to start trading)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    existsSyncMock
      .mockReturnValueOnce(false) // pre-write check (real: flagPath is fresh, not yet written)
      .mockReturnValueOnce(true) // post-write check (real: writeFile succeeded)
      .mockReturnValueOnce(true); // post-delete check: forced anomaly under test

    await expect(selfTestFileFlag(flagPath)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("delete did not have the expected effect"),
    );
    // The real unlink() genuinely ran (only isFlagPresent's own read was
    // forced) — this call goes through the mock's default passthrough (its
    // once-queue is exhausted), reflecting real disk state: the file really
    // is gone, despite selfTestFileFlag itself having been told (falsely)
    // that it was still there.
    expect(isFlagPresent(flagPath)).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});

describe("startFileFlagWatcher", () => {
  let flagPath: string;

  beforeEach(() => {
    // existsSyncMock's real-fs passthrough is re-armed by the file-level
    // beforeEach above on every test (including this block's) — this
    // block's own afterEach below calls vi.restoreAllMocks(), which would
    // otherwise wipe it (bare vi.fn() has no vi.spyOn original to restore
    // to, so restoreAllMocks degrades to a full reset), but by the time
    // that runs the file-level beforeEach has already re-armed it for the
    // NEXT test regardless.
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

  it("does not crash the process with an unhandled promise rejection when onFlagDetected is an async function that rejects after its first await — the parameter type is () => void, but TS's void-return assignability lets an async (=> Promise<void>) callback be passed here without a compile error, and the tick's try/catch only intercepts a SYNCHRONOUS throw", async () => {
    // Real timers for this one test: whether Node actually reports a promise
    // as unhandled depends on real microtask/event-loop timing, which
    // @sinonjs/fake-timers (used by vi.useFakeTimers() in beforeEach above)
    // does not drive — only Date/setTimeout/setInterval are faked, not the
    // Promise job queue. The edge-triggered polling logic itself is already
    // covered by the fake-timer tests above; this test is specifically about
    // what happens to the promise onFlagDetected returns.
    vi.useRealTimers();

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejection = new Error("async onFlagDetected blew up after its first await");
    // Deliberately NOT vi.fn()-wrapped: Vitest's mock instrumentation itself
    // attaches a settlement handler to a spied function's returned promise
    // (to populate mock.results / support toHaveResolved & friends), which
    // would make the promise "handled" for Node's purposes regardless of
    // whether startFileFlagWatcher does anything — defeating exactly the
    // scenario under test. A plain async function has nothing attached to
    // its returned promise except what startFileFlagWatcher itself attaches.
    //
    // @typescript-eslint/no-misused-promises correctly flags this shape (an
    // async — Promise-returning — function assigned/passed where () => void
    // is expected), same as it would flag it at startFileFlagWatcher's real
    // call site; this codebase's lint is a genuine second line of defense
    // against the exact footgun documented on startFileFlagWatcher above, on
    // top of tsc's void-return assignability hole. But lint isn't a runtime
    // guarantee (a differently-shaped pattern eslint's type analysis doesn't
    // trace, a future disabled/ignored rule, a file outside its glob, a
    // --no-verify commit) is all it takes to still ship this — which is
    // exactly why fileFlag.ts also needs its own runtime defense, and why
    // this test disables the rule for one line to exercise that defense
    // directly rather than relying on static analysis to have caught it.
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- see comment above: intentionally reproducing the exact unsafe pattern startFileFlagWatcher's runtime guard exists to catch.
    const onFlagDetected: () => void = async () => {
      callCount++;
      await Promise.resolve();
      throw rejection;
    };

    const unhandledRejections: unknown[] = [];
    const captureUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandled);

    const watcher = startFileFlagWatcher({ flagFilePath: flagPath, pollIntervalMs: 10 }, onFlagDetected);
    try {
      await writeFile(flagPath, "");
      // Real wall-clock wait spanning several poll intervals, long enough
      // for the transition to be observed, the async handler invoked, its
      // internal await to resume, and — absent a fix — for Node to have
      // flagged the resulting rejection as unhandled.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(callCount).toBe(1);
      // The real bug this guards against: without a fix, this array is
      // non-empty and the process crashes for real (not under a test
      // harness that merely observes the event) — in the one process whose
      // entire job is to survive to catch a halt trigger.
      expect(unhandledRejections).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(flagPath), rejection);
    } finally {
      watcher.stop();
      process.off("unhandledRejection", captureUnhandled);
    }
  });
});
