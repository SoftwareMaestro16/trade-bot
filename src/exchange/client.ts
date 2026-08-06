import { RestClientV5 } from "bybit-api";
import type { CategoryV5, GetInstrumentsInfoParamsV5 } from "bybit-api";
import { BybitError, normalizeBybitError } from "./errors.js";

export interface PublicExchangeClientOptions {
  testnet: boolean;
}

/**
 * ADR-002: the only place in this codebase allowed to import `bybit-api` directly
 * (NFR-11 — enforced by an eslint import-boundary rule, not just convention).
 *
 * Phase 1 scope only: public market-data endpoints, no API key required. Order
 * placement and any authenticated call is deliberately absent here — that belongs
 * to a later phase's execution/ work, per SRS "не пиши код на будущее".
 */
export class PublicExchangeClient {
  private readonly raw: RestClientV5;

  constructor(options: PublicExchangeClientOptions) {
    this.raw = new RestClientV5({
      testnet: options.testnet,
      // RR-51: the library defaults this to false, which resolves a retCode-failed
      // order as if it succeeded. Never rely on this default.
      throwExceptions: true,
    });
  }

  /** Wraps every raw call: normalizes errors (RR-03) and double-checks retCode (RR-51). */
  private async call<T extends { retCode: number; retMsg: string }>(
    fn: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      throw normalizeBybitError(e);
    }

    // Belt-and-suspenders per ADR-002: throwExceptions:true already makes this
    // unreachable today, but a defaults change in a future bybit-api release must
    // not silently reopen RR-51. Never trust the library's default to stay the same.
    if (result.retCode !== 0) {
      throw new BybitError(`Bybit retCode ${result.retCode}: ${result.retMsg}`, "retcode", {
        retCode: result.retCode,
        retMsg: result.retMsg,
      });
    }

    return result;
  }

  getInstrumentsInfo<C extends CategoryV5>(params: GetInstrumentsInfoParamsV5 & { category: C }) {
    return this.call(() => this.raw.getInstrumentsInfo(params));
  }

  getFundingRateHistory(params: Parameters<RestClientV5["getFundingRateHistory"]>[0]) {
    return this.call(() => this.raw.getFundingRateHistory(params));
  }

  getTickersLinear(params: { category: "linear"; symbol?: string }) {
    return this.call(() => this.raw.getTickers(params));
  }

  getTickersSpot(params: { category: "spot"; symbol?: string }) {
    return this.call(() => this.raw.getTickers(params));
  }

  getOpenInterest(params: Parameters<RestClientV5["getOpenInterest"]>[0]) {
    return this.call(() => this.raw.getOpenInterest(params));
  }

  getLongShortRatio(params: Parameters<RestClientV5["getLongShortRatio"]>[0]) {
    return this.call(() => this.raw.getLongShortRatio(params));
  }

  getOrderbook(params: Parameters<RestClientV5["getOrderbook"]>[0]) {
    return this.call(() => this.raw.getOrderbook(params));
  }

  /**
   * `GET /v5/market/risk-limit` — the margin-tier ladder (MMR/IMR per
   * position-notional bracket) a symbol's isolated-margin liquidation price
   * is computed from. Backs `emulation/liquidation.ts`'s `MarginTier` lookup
   * (RISK-REGISTER.md FM-38) and `src/scripts/fetchMarginTierData.ts`, the
   * one-off collector that snapshots this for the full tradeable universe.
   */
  getRiskLimit(params: Parameters<RestClientV5["getRiskLimit"]>[0]) {
    return this.call(() => this.raw.getRiskLimit(params));
  }
}
