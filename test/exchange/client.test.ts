import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
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
});
