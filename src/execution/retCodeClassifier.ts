/**
 * RSK-42 (SRS.md) / RISK-REGISTER.md FM-54: an unclassified Bybit `retCode`,
 * treated as generic failure, is the direct route from a routine rejection to
 * a naked leg — the classifier exists so abort either runs correctly or the
 * pair halts, never a silent guess in between.
 *
 * Codes transcribed verbatim from the fact-checked synthesis behind
 * RISK-REGISTER.md (its own FM-54 entry compresses this list to one line;
 * this file is the actual table, restored from that synthesis's raw output
 * rather than reconstructed from memory — wrong codes here cost real money).
 * One correction already folded in: the source material's initial pass wrote
 * `170094` for "Order notional value below the lower limit"; that code does
 * not exist on Bybit's V5 error page — the verified code is `110094`.
 *
 * Keyed by (transport, code), not code alone: `10016` means "Server error" in
 * the HTTP/UTA error table but "internal server error; Service is
 * restarting" in the WebSocket table (same for `10003`) — the same number is
 * two different facts depending on where it came from. Only the HTTP/UTA
 * transport is populated here; this project has no verified WS retCode table
 * yet (the private trading WS stream execution/ will eventually use), so
 * `Transport` is deliberately a single-value literal type rather than a wider
 * union with unverified entries silently defaulted in.
 */

export type Transport = "http";

export type RetCodeClass =
  | "FATAL_ABORT_PAIR"
  | "RESOLVE_BY_QUERY"
  | "RETRYABLE_WITH_BACKOFF"
  | "PRICE_BAND_REPRICE_REQUIRED"
  | "UNCLASSIFIED_HALT";

// Balance/margin insufficient for the requested action.
const FATAL_BALANCE_MARGIN = [110004, 110007, 110012, 110045, 110044];
// Size/notional outside allowed bounds. 110094 = "Order notional value below
// the lower limit" (170094, initially reported, does not exist — see module doc).
const FATAL_SIZE_NOTIONAL = [110017, 110094, 170136, 170140];
const FATAL_TOO_MANY_ACTIVE_ORDERS = [110020]; // >500 active orders
const FATAL_OI_POSITION_LIMIT = [110021];
const FATAL_RISK_LIMIT_LEVERAGE = [110086, 110090, 110016, 110047, 110048, 110013];
const FATAL_REDUCE_ONLY_MODE = [110023, 110042];
const FATAL_MISC = [110074, 110066, 110063];
const FATAL_TRADING_PAIR_STATE = [170151, 170157, 170210, 170149, 170124, 170381, 170382, 181012];
// Insufficient spot balance — the typical exit-path failure documented in FM-11
// (spot buy fee is deducted in the base coin, so the recorded qty can exceed
// the actual wallet balance by the time a close is attempted).
const FATAL_SPOT_EXIT_BALANCE = [170131, 170033];

const FATAL_ABORT_PAIR_CODES = new Set<number>([
  ...FATAL_BALANCE_MARGIN,
  ...FATAL_SIZE_NOTIONAL,
  ...FATAL_TOO_MANY_ACTIVE_ORDERS,
  ...FATAL_OI_POSITION_LIMIT,
  ...FATAL_RISK_LIMIT_LEVERAGE,
  ...FATAL_REDUCE_ONLY_MODE,
  ...FATAL_MISC,
  ...FATAL_TRADING_PAIR_STATE,
  ...FATAL_SPOT_EXIT_BALANCE,
]);

// Ambiguous outcome — the only legal next step is GET /v5/order/realtime (then
// /order/history, then /execution/list) by orderLinkId, never a blind resend
// or a blind abort (RSK-35/FM-17).
const RESOLVE_BY_QUERY_CODES = new Set<number>([
  10000, 10016, 170007, 170146, 170147, 110001, 170213, 110008, 110010, 170139,
  110072, 170141, 110030, 170150, 170190,
]);

// Transient — safe to retry with backoff. 110079 specifically means the order
// is alive but mid-transition on the matching engine: retry the CANCEL, not a
// resend, and note a plain two-bucket (retry vs not) classifier breaks exactly
// here mid-unwind (RISK-REGISTER.md FM-54's own caveat).
const RETRYABLE_WITH_BACKOFF_CODES = new Set<number>([10006, 10018, 10429, 170222, 110079]);

// RISK-REGISTER.md FM-36, verbatim: "Коды полосы (110003, 110120, 110121, spot
// 170192-194) никогда не ретраятся с той же ценой." A definitive rejection
// (nothing to resolve by query, the order was never placed), but NOT
// RETRYABLE_WITH_BACKOFF (that class means "resend the identical request" —
// exactly what FM-36 forbids here) and not necessarily FATAL_ABORT_PAIR
// either (unlike a balance/margin failure, a stale price is fixable by
// recomputing and resending at a fresh price, not a reason to give up on the
// whole pair). None of the other three classes is a correct fit — this is
// its own distinct class, not a gap silently left to fall through to
// UNCLASSIFIED_HALT (safe, but loses the "reprice and resend, don't retry
// as-is" information FM-36 explicitly provides).
const PRICE_BAND_REPRICE_REQUIRED_CODES = new Set<number>([110003, 110120, 110121, 170192, 170193, 170194]);

/**
 * Default is `UNCLASSIFIED_HALT` — an unrecognized code stops the pair and
 * raises a level-2 alert with the raw `retCode`/`retMsg` verbatim. It is never
 * treated as retryable and never treated as fatal-and-move-on: an unknown
 * failure is unknown, not harmless.
 */
export function classifyRetCode(transport: Transport, code: number): RetCodeClass {
  void transport; // single-valued today; kept as a parameter so a second transport can't be added without a real table for it
  if (FATAL_ABORT_PAIR_CODES.has(code)) return "FATAL_ABORT_PAIR";
  if (RESOLVE_BY_QUERY_CODES.has(code)) return "RESOLVE_BY_QUERY";
  if (RETRYABLE_WITH_BACKOFF_CODES.has(code)) return "RETRYABLE_WITH_BACKOFF";
  if (PRICE_BAND_REPRICE_REQUIRED_CODES.has(code)) return "PRICE_BAND_REPRICE_REQUIRED";
  return "UNCLASSIFIED_HALT";
}

// Exported for the completeness test: no code may appear in more than one
// class (RISK-REGISTER.md FM-54: "падает, если код продублирован или неоднозначен").
export const ALL_CLASSIFIED_CODES = {
  FATAL_ABORT_PAIR: FATAL_ABORT_PAIR_CODES,
  RESOLVE_BY_QUERY: RESOLVE_BY_QUERY_CODES,
  RETRYABLE_WITH_BACKOFF: RETRYABLE_WITH_BACKOFF_CODES,
  PRICE_BAND_REPRICE_REQUIRED: PRICE_BAND_REPRICE_REQUIRED_CODES,
} as const;
