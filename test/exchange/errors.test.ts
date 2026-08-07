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

  it("falls back to safe defaults when the http shape's code/message have drifted off-type (RR-03 shape-drift defense)", () => {
    // isHasRequestOptions only requires `requestOptions` to be present; `code` and `message`
    // are typed `unknown` on purpose because the exchange library's throw shape isn't
    // contractually guaranteed. Simulate that drift: code is not a number, message is not
    // a string, and the secret-bearing requestOptions is still attached.
    const secret = "SUPER_SECRET_DO_NOT_LEAK_2";
    const thrown = {
      code: "ERR_UNKNOWN", // not a number -> httpStatus fallback
      message: { nested: "object, not a string" }, // not a string -> message fallback
      requestOptions: { key: "FAKE_KEY_BBB", secret, testnet: false },
    };

    const err = normalizeBybitError(thrown);

    expect(err.kind).toBe("http");
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toBe("Bybit HTTP error: Bybit HTTP error");

    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(serialized).not.toContain(secret);
    expect(Object.keys(err)).not.toContain("requestOptions");
  });

  it("falls back to safe defaults when the http shape is missing code/message entirely", () => {
    // `code` and `message` are optional on HasRequestOptions; a throw that carries only
    // requestOptions (no code, no message) must not crash and must still redact.
    const thrown = { requestOptions: { key: "FAKE_KEY_CCC", secret: "x" } };

    const err = normalizeBybitError(thrown);

    expect(err.kind).toBe("http");
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toBe("Bybit HTTP error: Bybit HTTP error");
  });

  it("classifies a retCode failure distinctly from an HTTP failure (RR-51)", () => {
    const thrown = { retCode: 110007, retMsg: "ab not enough for new order" };
    const err = normalizeBybitError(thrown);

    expect(err.kind).toBe("retcode");
    expect(err.retCode).toBe(110007);
    expect(err.retMsg).toBe("ab not enough for new order");
  });

  it("falls back cleanly when a retCode failure has no usable retMsg (line 73 fallback)", () => {
    // Bybit's docs say retMsg is always a string, but nothing upstream validates
    // that before it reaches here — a malformed/unusual API response could omit
    // retMsg entirely or send a non-string. The `undefined` branch of
    // `typeof e.retMsg === "string" ? e.retMsg : undefined` must not produce a
    // literal "undefined" in the alert-facing message, and must not throw.

    const missing = normalizeBybitError({ retCode: 110007 });
    expect(missing.kind).toBe("retcode");
    expect(missing.retCode).toBe(110007);
    expect(missing.retMsg).toBeUndefined();
    expect(missing.message).toBe("Bybit retCode 110007");
    expect(missing.message).not.toContain("undefined");

    const nullMsg = normalizeBybitError({ retCode: 110007, retMsg: null });
    expect(nullMsg.retMsg).toBeUndefined();
    expect(nullMsg.message).toBe("Bybit retCode 110007");
    expect(nullMsg.message).not.toContain("null");

    const numericMsg = normalizeBybitError({ retCode: 110007, retMsg: 42 });
    expect(numericMsg.retMsg).toBeUndefined();
    expect(numericMsg.message).toBe("Bybit retCode 110007");
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
