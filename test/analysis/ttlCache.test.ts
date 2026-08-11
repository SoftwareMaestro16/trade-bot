import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../../src/analysis/ttlCache.js";

describe("TtlCache", () => {
  it("отдаёт null на пустом кэше", () => {
    const c = new TtlCache<number>(1000);
    expect(c.get()).toBeNull();
  });

  it("отдаёт значение в пределах TTL и протухает после", () => {
    let t = 0;
    const c = new TtlCache<string>(1000, () => t);
    c.set("v");
    expect(c.get()).toBe("v");
    t = 999;
    expect(c.get()).toBe("v"); // ещё живо
    t = 1000;
    expect(c.get()).toBeNull(); // ровно на границе протухло
  });

  it("getOrCompute считает один раз в пределах TTL, потом пересчитывает", async () => {
    let t = 0;
    const c = new TtlCache<number>(1000, () => t);
    const compute = vi.fn().mockResolvedValue(42);

    expect(await c.getOrCompute(compute)).toBe(42);
    expect(await c.getOrCompute(compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1); // второй раз — из кэша

    t = 1000; // протухло
    await c.getOrCompute(compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("invalidate заставляет пересчитать до истечения TTL", async () => {
    const c = new TtlCache<number>(100000);
    const compute = vi.fn().mockResolvedValue(1);
    await c.getOrCompute(compute);
    c.invalidate();
    await c.getOrCompute(compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
