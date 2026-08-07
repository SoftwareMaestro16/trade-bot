import { describe, expect, it } from "vitest";
import { buildOrderLinkId, parseOrderLinkId } from "../../src/execution/orderLinkId.js";

describe("buildOrderLinkId", () => {
  it("produces a fixed-width, hyphen-separated, leg-namespaced ID", () => {
    const id = buildOrderLinkId({ epoch: 1, intentSeq: 42, leg: "perp" });
    expect(id).toBe("000001-00000042-P");
  });

  it("uses 'S' for spot and 'P' for perp", () => {
    expect(buildOrderLinkId({ epoch: 0, intentSeq: 0, leg: "spot" })).toBe("000000-00000000-S");
    expect(buildOrderLinkId({ epoch: 0, intentSeq: 0, leg: "perp" })).toBe("000000-00000000-P");
  });

  it("is always exactly 17 characters — well under Bybit's 36-char limit (RSK-36)", () => {
    const id = buildOrderLinkId({ epoch: 999_999, intentSeq: 99_999_999, leg: "spot" });
    expect(id).toHaveLength(17);
    expect(id.length).toBeLessThanOrEqual(36);
  });

  it("only ever contains Bybit's allowed charset [A-Za-z0-9_-]", () => {
    const id = buildOrderLinkId({ epoch: 123, intentSeq: 456, leg: "perp" });
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a negative or non-integer epoch instead of silently truncating", () => {
    expect(() => buildOrderLinkId({ epoch: -1, intentSeq: 0, leg: "spot" })).toThrow(RangeError);
    expect(() => buildOrderLinkId({ epoch: 1.5, intentSeq: 0, leg: "spot" })).toThrow(RangeError);
  });

  it("rejects a negative or non-integer intentSeq instead of silently truncating", () => {
    expect(() => buildOrderLinkId({ epoch: 0, intentSeq: -1, leg: "spot" })).toThrow(RangeError);
    expect(() => buildOrderLinkId({ epoch: 0, intentSeq: 1.5, leg: "spot" })).toThrow(RangeError);
  });

  it("rejects an epoch or intentSeq beyond the fixed field width", () => {
    expect(() => buildOrderLinkId({ epoch: 1_000_000, intentSeq: 0, leg: "spot" })).toThrow(RangeError);
    expect(() => buildOrderLinkId({ epoch: 0, intentSeq: 100_000_000, leg: "spot" })).toThrow(RangeError);
  });

  it("accepts the maximum representable epoch and intentSeq without overflowing the fixed width", () => {
    const id = buildOrderLinkId({ epoch: 999_999, intentSeq: 99_999_999, leg: "perp" });
    expect(id).toBe("999999-99999999-P");
  });
});

describe("parseOrderLinkId", () => {
  it("round-trips every field exactly through build -> parse", () => {
    const original = { epoch: 7, intentSeq: 123, leg: "perp" as const };
    const id = buildOrderLinkId(original);
    expect(parseOrderLinkId(id)).toEqual(original);
  });

  it("round-trips the spot leg too", () => {
    const original = { epoch: 42, intentSeq: 0, leg: "spot" as const };
    expect(parseOrderLinkId(buildOrderLinkId(original))).toEqual(original);
  });

  it("returns null (never throws) for a foreign or malformed ID — e.g. something Bybit itself generated", () => {
    expect(parseOrderLinkId("not-our-format")).toBeNull();
    expect(parseOrderLinkId("")).toBeNull();
    expect(parseOrderLinkId("000001-00000042-X")).toBeNull(); // invalid leg code
    expect(parseOrderLinkId("1-42-P")).toBeNull(); // not zero-padded to fixed width
    expect(parseOrderLinkId("000001-00000042-P-extra")).toBeNull();
  });
});
