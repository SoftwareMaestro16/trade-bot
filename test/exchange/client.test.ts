import nock from "nock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BybitError } from "../../src/exchange/errors.js";
import { PublicExchangeClient } from "../../src/exchange/client.js";

const TESTNET_BASE = "https://api-testnet.bybit.com";

afterEach(() => {
  nock.cleanAll();
});

describe("PublicExchangeClient", () => {
  it("rejects (does not silently resolve) when Bybit returns a non-zero retCode with HTTP 200 (RR-51)", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query(true)
      .reply(200, { retCode: 110001, retMsg: "Order does not exist", result: {}, time: Date.now() });

    const client = new PublicExchangeClient({ testnet: true });

    await expect(
      client.getInstrumentsInfo({ category: "linear" }),
    ).rejects.toMatchObject({ kind: "retcode", retCode: 110001 });
  });

  it("rejects when raw.<method> itself resolves (rather than throws) with a non-zero retCode — client.ts's own RR-51 recheck at lines 43-48, not bybit-api's throwExceptions path", async () => {
    // The test above goes through nock, i.e. a real HTTP round-trip, which
    // bybit-api's BaseRestClient turns into a *throw* itself before call()'s
    // `await fn()` ever gets a chance to resolve (throwExceptions:true —
    // confirmed at node_modules/bybit-api/lib/util/BaseRestClient.js:198,
    // `if (this.options.throwExceptions && result.retCode !== 0) throw result;`).
    // So that test only ever exercises normalizeBybitError's isHasRetCode
    // branch, never client.ts's own manual `result.retCode !== 0` recheck.
    //
    // Here raw.getInstrumentsInfo is mocked to *resolve* with a failing
    // retCode instead — the exact shape it would take if a future bybit-api
    // release silently changed throwExceptions' behavior. This is the one
    // path that actually reaches (and would catch a regression in) client.ts
    // lines 43-48 themselves.
    const client = new PublicExchangeClient({ testnet: true });
    vi.spyOn(client["raw"], "getInstrumentsInfo").mockResolvedValue({
      retCode: 110001,
      retMsg: "Order does not exist",
      result: { category: "linear", list: [] },
      retExtInfo: {},
      time: Date.now(),
    });

    await expect(
      client.getInstrumentsInfo({ category: "linear" }),
    ).rejects.toMatchObject({ kind: "retcode", retCode: 110001 });
  });

  it("resolves normally on retCode 0 (happy path)", async () => {
    const body = {
      retCode: 0,
      retMsg: "OK",
      result: { category: "linear", list: [] },
      retExtInfo: {},
      time: Date.now(),
    };
    nock(TESTNET_BASE).get("/v5/market/instruments-info").query(true).reply(200, body);

    const client = new PublicExchangeClient({ testnet: true });
    const result = await client.getInstrumentsInfo({ category: "linear" });

    expect(result.retCode).toBe(0);
    expect(result.result.list).toEqual([]);
  });

  it("normalizes a 5xx HTTP failure into a BybitError instead of propagating the raw library throw", async () => {
    nock(TESTNET_BASE).get("/v5/market/instruments-info").query(true).reply(500, "Internal Server Error");

    const client = new PublicExchangeClient({ testnet: true });

    await expect(client.getInstrumentsInfo({ category: "linear" })).rejects.toBeInstanceOf(BybitError);
  });

  it("normalizes a network-level failure (connection reset) into a BybitError", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query(true)
      .replyWithError(new Error("socket hang up"));

    const client = new PublicExchangeClient({ testnet: true });

    await expect(client.getInstrumentsInfo({ category: "linear" })).rejects.toBeInstanceOf(BybitError);
  });

  it("aborts a call that hangs past requestTimeoutMs instead of waiting forever (2026-08-07 production incident: a single stalled request with no timeout blocked collectSettledFunding's entire sequential sweep, and therefore every future sweep, permanently)", async () => {
    // Simulates a black-holed connection: nock never actually answers within
    // this test's lifetime, standing in for a stalled TCP connection with no
    // RST — the same class of failure telegramPolling.test.ts's own
    // "aborts a getUpdates call that hangs" test simulates the same way.
    nock(TESTNET_BASE).get("/v5/market/instruments-info").query(true).delay(60_000).reply(200, {
      retCode: 0,
      retMsg: "OK",
      result: { category: "linear", list: [] },
      retExtInfo: {},
      time: Date.now(),
    });

    const client = new PublicExchangeClient({ testnet: true, requestTimeoutMs: 100 });

    await expect(client.getInstrumentsInfo({ category: "linear" })).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("does not abort a call that resolves comfortably within requestTimeoutMs", async () => {
    nock(TESTNET_BASE)
      .get("/v5/market/instruments-info")
      .query(true)
      .delay(10)
      .reply(200, {
        retCode: 0,
        retMsg: "OK",
        result: { category: "linear", list: [] },
        retExtInfo: {},
        time: Date.now(),
      });

    const client = new PublicExchangeClient({ testnet: true, requestTimeoutMs: 5000 });

    await expect(client.getInstrumentsInfo({ category: "linear" })).resolves.toMatchObject({ retCode: 0 });
  });
});
