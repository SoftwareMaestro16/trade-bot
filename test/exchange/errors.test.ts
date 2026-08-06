import { describe, expect, it } from "vitest";
import { BybitError, normalizeBybitError } from "../../src/exchange/errors.js";

describe("normalizeBybitError", () => {
  it("never leaks the API secret from a requestOptions-shaped throw (RR-03)", () => {
    // Exact shape reproduced from node_modules/bybit-api/lib/util/BaseRestClient.js
    // parseException(): `throw { code, message, body, headers, requestOptions: this.options }`.
    const secret = "SUPER_SECRET_DO_NOT_LEAK";
    const key = "FAKE_KEY_AAA";
    const thrown = {
      code: 500,
      message: "Internal Server Error",
      body: { retCode: 10016, retMsg: "Server error." },
      headers: {},
      requestOptions: { key, secret, testnet: false },
    };

    const err = normalizeBybitError(thrown);

    expect(err).toBeInstanceOf(BybitError);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("http");
    expect(err.httpStatus).toBe(500);

    // The secret/key must not appear anywhere reachable off the resulting error:
    // not in the message, not in the stack, not as an enumerable own property.
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(key);
    expect(err.message).not.toContain(secret);
    expect(err.stack ?? "").not.toContain(secret);
    expect(Object.keys(err)).not.toContain("requestOptions");
  });

  it("classifies a retCode failure distinctly from an HTTP failure (RR-51)", () => {
    const thrown = { retCode: 110007, retMsg: "ab not enough for new order" };
    const err = normalizeBybitError(thrown);

    expect(err.kind).toBe("retcode");
    expect(err.retCode).toBe(110007);
    expect(err.retMsg).toBe("ab not enough for new order");
  });

  it("handles the network-failure shape (`throw e.message`, a bare string)", () => {
    const err = normalizeBybitError("ETIMEDOUT");
    expect(err.kind).toBe("network");
    expect(err.message).toContain("ETIMEDOUT");
  });

  it("handles a bare Error thrown with no response (request made, no reply)", () => {
    const err = normalizeBybitError(new Error("socket hang up"));
    expect(err.kind).toBe("network");
    expect(err.message).toContain("socket hang up");
  });

  it("falls back to 'unknown' for an unrecognized shape rather than losing the failure silently", () => {
    const err = normalizeBybitError(42);
    expect(err.kind).toBe("unknown");
    expect(err).toBeInstanceOf(Error);
  });
});
