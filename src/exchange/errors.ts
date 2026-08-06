/**
 * ADR-002 / RR-03 / RR-51: bybit-api 4.7.3 throws plain objects, not Error instances,
 * and on non-2xx responses one of those objects carries `requestOptions: this.options`,
 * which includes the API key and secret verbatim (verified against the installed
 * node_modules/bybit-api/lib/util/BaseRestClient.js#parseException).
 *
 * Every error that crosses this module's boundary is normalized into a BybitError
 * that never carries the raw options object, regardless of which of the library's
 * several distinct throw shapes produced it.
 */

export type BybitErrorKind =
  | "http" // non-2xx HTTP response (BaseRestClient#parseException, has requestOptions)
  | "retcode" // HTTP 200 but retCode !== 0 (thrown only when throwExceptions:true)
  | "network" // request sent, no response received (throw e.message or throw e)
  | "unknown";

export class BybitError extends Error {
  readonly kind: BybitErrorKind;
  readonly httpStatus: number | undefined;
  readonly retCode: number | undefined;
  readonly retMsg: string | undefined;

  constructor(
    message: string,
    kind: BybitErrorKind,
    extra?: { httpStatus?: number | undefined; retCode?: number | undefined; retMsg?: string | undefined },
  ) {
    super(message);
    this.name = "BybitError";
    this.kind = kind;
    this.httpStatus = extra?.httpStatus;
    this.retCode = extra?.retCode;
    this.retMsg = extra?.retMsg;
  }
}

interface HasRequestOptions {
  requestOptions: unknown;
  code?: unknown;
  message?: unknown;
  body?: unknown;
}

interface HasRetCode {
  retCode: number;
  retMsg?: unknown;
}

function isHasRequestOptions(e: unknown): e is HasRequestOptions {
  return typeof e === "object" && e !== null && "requestOptions" in e;
}

function isHasRetCode(e: unknown): e is HasRetCode {
  return typeof e === "object" && e !== null && "retCode" in e;
}

/**
 * Converts any value bybit-api might throw into a BybitError, guaranteeing the
 * secret-bearing `requestOptions` field never survives into a log line, a rethrown
 * error, or a stack trace. Never trust a caller upstream to remember to redact —
 * that is exactly the mistake RR-03 exists to prevent.
 */
export function normalizeBybitError(e: unknown): BybitError {
  if (isHasRequestOptions(e)) {
    // Deliberately do NOT spread `e` or touch `e.requestOptions` anywhere below.
    const httpStatus = typeof e.code === "number" ? e.code : undefined;
    const message = typeof e.message === "string" ? e.message : "Bybit HTTP error";
    return new BybitError(`Bybit HTTP error: ${message}`, "http", { httpStatus });
  }

  if (isHasRetCode(e)) {
    const retMsg = typeof e.retMsg === "string" ? e.retMsg : undefined;
    return new BybitError(
      `Bybit retCode ${e.retCode}${retMsg ? `: ${retMsg}` : ""}`,
      "retcode",
      { retCode: e.retCode, retMsg },
    );
  }

  if (typeof e === "string") {
    // BaseRestClient#parseException: `throw e.message` on network failure with no response.
    return new BybitError(`Bybit network error: ${e}`, "network");
  }

  if (e instanceof Error) {
    return new BybitError(`Bybit network error: ${e.message}`, "network");
  }

  return new BybitError("Bybit error: unrecognized error shape", "unknown");
}
