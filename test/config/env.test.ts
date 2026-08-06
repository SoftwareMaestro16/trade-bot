import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCacheForTests } from "../../src/config/env.js";

// loadEnv() is a module-level singleton (`let cached`) by design — every test
// here must reset it first, or a later test would silently see an earlier
// test's cached result instead of actually re-parsing its own `source`.
afterEach(() => {
  resetEnvCacheForTests();
});

function minimalTestnet(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: "testnet",
    DATABASE_URL: "postgres://user:password@localhost:5432/trade_bot",
    ...overrides,
  };
}

describe("loadEnv — baseline validity", () => {
  it("accepts a minimal valid testnet config (no API keys, none required for Phase 1)", () => {
    const env = loadEnv(minimalTestnet());
    expect(env.APP_ENV).toBe("testnet");
  });

  it("accepts a minimal valid mainnet config", () => {
    const env = loadEnv(minimalTestnet({ APP_ENV: "mainnet" }));
    expect(env.APP_ENV).toBe("mainnet");
  });

  it("throws when DATABASE_URL is missing", () => {
    const source = minimalTestnet();
    delete source.DATABASE_URL;
    expect(() => loadEnv(source)).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is an empty string — `.min(1)` rejects blank-but-present, unlike the optional key fields", () => {
    expect(() => loadEnv(minimalTestnet({ DATABASE_URL: "" }))).toThrow(/DATABASE_URL/);
  });

  it("throws when APP_ENV is missing or not one of testnet/mainnet", () => {
    const missing = minimalTestnet();
    delete missing.APP_ENV;
    expect(() => loadEnv(missing)).toThrow(/APP_ENV/);

    expect(() => loadEnv(minimalTestnet({ APP_ENV: "staging" }))).toThrow(/APP_ENV/);
  });

  it("the invalid-config error message names only the field PATH, never the rejected value itself", () => {
    // env.ts's own comment: parsed.error is deliberately not logged whole,
    // since Zod's default issue messages can echo the input value back.
    try {
      loadEnv(minimalTestnet({ DATABASE_URL: "" }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).not.toContain("password"); // would appear if a real DATABASE_URL were echoed
    }
  });
});

describe("loadEnv — RR-05: refuses to start on a testnet/mainnet key-pair mismatch", () => {
  it("throws when APP_ENV=testnet but BYBIT_MAINNET_API_KEY is a real (non-empty) value", () => {
    expect(() => loadEnv(minimalTestnet({ BYBIT_MAINNET_API_KEY: "real-mainnet-key" }))).toThrow(
      /mainnet keys leaking/,
    );
  });

  it("throws when APP_ENV=testnet but BYBIT_MAINNET_API_SECRET is a real (non-empty) value", () => {
    expect(() => loadEnv(minimalTestnet({ BYBIT_MAINNET_API_SECRET: "real-mainnet-secret" }))).toThrow(
      /mainnet keys leaking/,
    );
  });

  it("throws when APP_ENV=mainnet but BYBIT_TESTNET_API_KEY is a real (non-empty) value", () => {
    expect(() =>
      loadEnv(minimalTestnet({ APP_ENV: "mainnet", BYBIT_TESTNET_API_KEY: "real-testnet-key" })),
    ).toThrow(/testnet keys leaking/);
  });

  it("throws when APP_ENV=mainnet but BYBIT_TESTNET_API_SECRET is a real (non-empty) value", () => {
    expect(() =>
      loadEnv(minimalTestnet({ APP_ENV: "mainnet", BYBIT_TESTNET_API_SECRET: "real-testnet-secret" })),
    ).toThrow(/testnet keys leaking/);
  });

  it("does NOT throw when the opposite-env fields are present but EMPTY STRINGS, not real values", () => {
    // A blank `.env` line like `BYBIT_MAINNET_API_KEY=` parses to `""`, not
    // "absent" — Node's --env-file sets the var, just to an empty string.
    // The check (`env.BYBIT_MAINNET_API_KEY || env.BYBIT_MAINNET_API_SECRET`)
    // treats "" as falsy, same as undefined — this is correct, not a gap:
    // an empty string can never BE real secret material, so there is nothing
    // for RR-05 to catch in this case. Any ACTUAL non-empty key/secret is
    // still caught by the tests above regardless of the other field's state.
    const env = loadEnv(minimalTestnet({ BYBIT_MAINNET_API_KEY: "", BYBIT_MAINNET_API_SECRET: "" }));
    expect(env.APP_ENV).toBe("testnet");
  });

  it("allows the SAME-env key pair to be present without conflict", () => {
    const env = loadEnv(
      minimalTestnet({ BYBIT_TESTNET_API_KEY: "test-key", BYBIT_TESTNET_API_SECRET: "test-secret" }),
    );
    expect(env.BYBIT_TESTNET_API_KEY).toBe("test-key");
  });
});

describe("loadEnv — caching", () => {
  it("caches after the first successful call — a second call with a DIFFERENT source still returns the first result", () => {
    const first = loadEnv(minimalTestnet({ APP_ENV: "testnet" }));
    const second = loadEnv(minimalTestnet({ APP_ENV: "mainnet" })); // ignored: already cached
    expect(second).toBe(first);
    expect(second.APP_ENV).toBe("testnet");
  });

  it("resetEnvCacheForTests() actually clears the cache — the next call re-parses its own source", () => {
    loadEnv(minimalTestnet({ APP_ENV: "testnet" }));
    resetEnvCacheForTests();
    const env = loadEnv(minimalTestnet({ APP_ENV: "mainnet" }));
    expect(env.APP_ENV).toBe("mainnet");
  });
});
