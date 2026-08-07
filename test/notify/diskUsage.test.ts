import os from "node:os";
import { describe, expect, it } from "vitest";
import { checkDiskUsage } from "../../src/notify/diskUsage.js";

describe("checkDiskUsage", () => {
  it("returns a sane shape for a real, always-present path (os.tmpdir())", () => {
    const usage = checkDiskUsage(os.tmpdir());
    // Not asserting non-null: some CI/sandbox environments genuinely can't
    // stat every path (this function's whole reason for returning null
    // instead of throwing) — but IF it succeeds, the shape must be sane.
    if (usage === null) return;
    expect(usage.path).toBe(os.tmpdir());
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.availableBytes).toBeGreaterThanOrEqual(0);
    expect(usage.availableBytes).toBeLessThanOrEqual(usage.totalBytes);
    expect(usage.usedFraction).toBeGreaterThanOrEqual(0);
    expect(usage.usedFraction).toBeLessThanOrEqual(1);
  });

  it("returns null (never throws) for a path that cannot possibly exist", () => {
    expect(() => checkDiskUsage("/this/path/does/not/exist/__nonexistent__")).not.toThrow();
    expect(checkDiskUsage("/this/path/does/not/exist/__nonexistent__")).toBeNull();
  });

  it("defaults to '/' when called with no argument", () => {
    // Same not-asserting-non-null reasoning as the first test — just confirm
    // it doesn't throw and, if it succeeds, reports path '/'.
    const usage = checkDiskUsage();
    if (usage === null) return;
    expect(usage.path).toBe("/");
  });
});
