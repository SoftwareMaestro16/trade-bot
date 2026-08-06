import Big from "big.js";

// normalizeFunding.ts's canonical "r8h" basis is an 8-hour interval
// (REFERENCE_INTERVAL_MINUTES=480 there, i.e. 480/60=8h) — reused here so an
// hourly borrow rate scales to the same basis `r8h` itself is measured in.
const R8H_HOURS = 8;

/**
 * RISK-REGISTER.md FM-27 (mechanism): Bybit's Auto-Borrow can finance the
 * spot leg with borrowed USDT — not only when free balance is short, but
 * whenever the short perp leg is sitting on an unrealized loss, so it can
 * fire on ANY delta-neutral position, not only ones explicitly opened on
 * margin. FM-09 (why it matters): a live VIP0 snapshot found
 * `hourlyBorrowRate = 0.0000044069` (≈3.860% APR, measured 2026-08-05) — at
 * `r8h = 0.010%`, that eats ~35% of gross funding on a fully-borrowed
 * position; realized BTC 2026 YTD funding (≈1.8%/yr) sits BELOW that
 * borrow cost, meaning majors financed this way lost money on carry alone.
 *
 * `risk/economics.ts`'s `computeNetFundingRate`/`checkNetFundingRate` consume
 * this function's return value directly as `borrowCost8h`: same r8h basis
 * and sign as `r8h` itself (a positive cost, subtracted there — see
 * `computeNetFundingRate`'s `r8h.minus(borrowCost8h)`), and PARAMS-CONSERVATIVE
 * §5's `MIN_NET_FUNDING_RATE_R8H` floor (0.0002, i.e. 0.02%) is compared
 * directly against that difference. So this MUST return a rate of the same
 * ~0.01%–0.1% order of magnitude as `r8h` — never a raw USDT amount.
 *
 * Only the BORROWED slice of the position accrues interest — the trader's
 * own equity (`positionNotional / leverage`, same "effective leverage"
 * definition risk/leverage.ts's `checkLeverage` fixes as `notional / equity`,
 * reused here for consistency rather than reinventing it) is never lent and
 * costs nothing. The borrowed fraction is `1 - 1/leverage`. Because the
 * result is a RATE relative to the position's own notional rather than a
 * dollar figure, that fraction is scale-invariant: `positionNotional`
 * cancels out of the arithmetic algebraically (an $X and a $10,000X position
 * at the same leverage and rate pay the exact same borrowCost8h RATE, even
 * though the dollar interest differs). `positionNotional` is kept as a
 * parameter anyway — matching the natural "how much would this position
 * actually finance" shape the task and risk/leverage.ts both use, and
 * validated the same defensive way `checkLeverage` validates `totalEquity`
 * — but it deliberately does not appear in the return expression below;
 * that is this invariant, not an oversight.
 *
 * At `leverage=1` (the baseline, no-margin case — also PARAMS-CONSERVATIVE.md
 * §6's "spot only with own money" rule under normal operation) the borrowed
 * fraction is exactly `1 - 1/1 = 0`, so this returns exactly zero for ANY
 * notional and ANY rate — an algebraic identity of the formula below, not a
 * special-cased branch, so the invariant holds unconditionally rather than
 * depending on every caller remembering to special-case it.
 *
 * `hourlyBorrowRate` is a required, explicit parameter, never a hardcoded
 * constant: neither PARAMS-CONSERVATIVE.md (the owner-confirmed conservative
 * profile) nor RISK-REGISTER.md pins a standing figure meant for production
 * use — FM-09's number above is a single dated market snapshot cited as
 * evidence the cost is *material*, not a value meant to be baked into code
 * (Auto-Borrow rates move with market conditions, the same reason RR-26
 * reads fee rates live from `/v5/account/fee-rate` at startup rather than
 * trusting a hardcoded VIP0 figure beyond a logged fallback). The real rate
 * must be sourced from Bybit before this is used for a real entry decision.
 * HOURLY, not daily: FM-09 documents Bybit charging Auto-Borrow interest
 * hourly ("списание — на 5-й минуте каждого часа"), so that is the unit
 * this function expects, not the daily-then-convert shape a generic
 * borrow-rate assumption might suggest.
 *
 * `PARAMS-CONSERVATIVE.md §10`'s 1.5x hard leverage ceiling is NOT
 * re-enforced here — that veto lives in `risk/leverage.ts`'s `checkLeverage`
 * and belongs there; this function only computes a cost for whatever
 * leverage it is given, it does not gate anything.
 */
export function computeBorrowCost8h(leverage: Big, positionNotional: Big, hourlyBorrowRate: Big): Big {
  if (leverage.lt(1)) {
    throw new RangeError(
      `leverage must be >= 1 (1.0 = fully self-funded, no borrowing), got ${leverage.toString()}`,
    );
  }
  if (positionNotional.lt(0)) {
    throw new RangeError(`positionNotional must be non-negative, got ${positionNotional.toString()}`);
  }

  const borrowedFraction = new Big(1).minus(new Big(1).div(leverage));
  const rate8hIfFullyBorrowed = hourlyBorrowRate.times(R8H_HOURS);
  return borrowedFraction.times(rate8hIfFullyBorrowed);
}
