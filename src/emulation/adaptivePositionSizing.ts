import Big from "big.js";

/**
 * Owner's own request, verbatim (translated): "how to use the deposit should
 * be the bot's own decision — but there's a rule: early on, with no trade
 * history, or after a significant loss, size small; with a track record of
 * profit behind it, size up." An anti-martingale sizing rule (grow after
 * wins, shrink after losses) — the safe direction, as opposed to a
 * martingale (grow after LOSSES, chasing them), which this is deliberately
 * not.
 *
 * Pure fold over ordered trade history — no external mutable "current
 * fraction" state to keep in sync with the caller; the fraction at any point
 * is fully determined by replaying history from the start. Deliberately
 * conservative in every constant below (documented per-value) since this is
 * the ONE thing directly controlling how much of the deposit is at risk per
 * trade — same discipline as PARAMS-CONSERVATIVE.md's rest of the numbers.
 */

/** First trade of a scenario, zero track record — half of BASE_FRACTION. */
export const NO_HISTORY_FRACTION = new Big("0.10");

/** Floor — never sized smaller than this regardless of losing streak length. */
export const MIN_FRACTION = new Big("0.05");

/**
 * Ceiling — deliberately set to EXACTLY match PARAMS-CONSERVATIVE.md §11's
 * hard 25% concentration cap (the same ceiling risk/index.ts's checkEntry
 * enforces independently). This adaptive model can therefore never even
 * ATTEMPT to request a size the hard risk ceiling would reject — the two
 * numbers are the same number on purpose, not a coincidence to keep in sync
 * by hand.
 */
export const MAX_FRACTION = new Big("0.25");

/** Step size per up/down adjustment — one trade's outcome moves the fraction by at most this much. */
export const STEP = new Big("0.05");

/**
 * A loss counts as "significant" (owner's own word) when it exceeds this
 * fraction of the equity the position was sized against — 3% chosen as a
 * conservative bar: small enough that an ordinary losing trade within normal
 * variance doesn't trigger a step-down (that would make the model
 * over-react to noise), large enough that it's clearly worse than a routine
 * loss. Revisit once Фаза 2 produces a real loss-size distribution to
 * calibrate against instead of a judgment call.
 */
export const SIGNIFICANT_LOSS_THRESHOLD_PCT_OF_EQUITY = new Big("0.03");

export interface TradeOutcome {
  /** Signed realized P&L for this closed trade (execution/realizedPnl.ts's total). */
  realizedPnl: Big;
  /** Total equity immediately after this trade closed — normalizes the loss/gain to a percentage, not a raw dollar amount, so the rule scales with account size. */
  equityAtClose: Big;
}

/**
 * `history` must be in chronological order (oldest first) — this function
 * replays it as a fold, so out-of-order input silently produces a wrong
 * (but not crashing) answer. Callers append each newly-closed trade to the
 * end of their own history array, which naturally satisfies this.
 */
export function computeNextPositionSizeFraction(history: readonly TradeOutcome[]): Big {
  if (history.length === 0) return NO_HISTORY_FRACTION;

  let fraction = NO_HISTORY_FRACTION;
  const significantLossBar = SIGNIFICANT_LOSS_THRESHOLD_PCT_OF_EQUITY.times(-1);

  for (let i = 0; i < history.length; i++) {
    const trade = history[i];
    if (!trade) continue; // unreachable given the loop bound, satisfies noUncheckedIndexedAccess
    if (trade.equityAtClose.lte(0)) {
      // Same "when in doubt, withhold trust" direction as the rest of this
      // codebase's risk checks — a wiped-out or negative account has no
      // meaningful percentage to compute; treat it exactly like a
      // significant loss (step down / floor), never as neutral or up.
      fraction = fraction.minus(STEP);
    } else {
      const pnlPctOfEquity = trade.realizedPnl.div(trade.equityAtClose);
      const isSignificantLoss = pnlPctOfEquity.lt(significantLossBar);
      const isWin = trade.realizedPnl.gt(0);
      const previousTrade = i > 0 ? history[i - 1] : undefined;
      const previousIsWin = previousTrade !== undefined && previousTrade.realizedPnl.gt(0);

      if (isSignificantLoss) {
        fraction = fraction.minus(STEP);
      } else if (isWin && previousIsWin) {
        fraction = fraction.plus(STEP);
      }
      // else: an ordinary (non-significant) loss, a single isolated win, or
      // a breakeven trade — no adjustment, matches the owner's framing that
      // only a real losing/winning STREAK should move the needle, not
      // single-trade noise.
    }

    if (fraction.lt(MIN_FRACTION)) fraction = MIN_FRACTION;
    if (fraction.gt(MAX_FRACTION)) fraction = MAX_FRACTION;
  }

  return fraction;
}
