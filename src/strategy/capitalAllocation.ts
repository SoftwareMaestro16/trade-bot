import Big from "big.js";

/**
 * Owner's model (2026-08-10), verbatim intent: a deposit split into a working
 * part that grows after profitable trades and shrinks after losses, plus a
 * cushion, plus an idle part that could earn yield elsewhere — all expressed
 * as PERCENTAGES rather than hardcoded dollar amounts, so the same policy
 * works at $1k and at $10k.
 *
 * This module owns the SPLIT only. It deliberately does not decide when to
 * trade (risk/), how to rank candidates (strategy/rankCandidates.ts), or what
 * a position costs (execution/) — it answers one question: given total equity
 * and a track record, how many dollars may be committed, how many must stay
 * liquid, and how many are genuinely idle.
 *
 * ## The 2x capital fact this model exists to make explicit
 *
 * A delta-neutral position is TWO legs: buy N dollars of spot, short N dollars
 * of perp. emulation/{positionLifecycle,equityEngine}.ts both price that as
 * `initialCapital = spotNotional + perpNotional / leverage`. At leverage 1.0
 * (PARAMS-CONSERVATIVE.md's self-funded posture) that is `N + N = 2N` — so a
 * dollar of funding-earning notional consumes TWO dollars of capital, and a
 * naive "put 80% of the deposit to work" target silently asks for 160% of it.
 *
 * `notionalForCapital` below is the inverse of that relation and is the only
 * sanctioned way to turn a capital budget into a notional target. Funding
 * income accrues on NOTIONAL, so mixing the two up overstates expected income
 * by exactly the factor `(1 + 1/leverage)`.
 *
 * ## Why the cushion is carved out before anything else
 *
 * The cushion exists to absorb a margin call or a losing streak WITHOUT
 * force-closing a live hedge. That makes liquidity, not size, its defining
 * property — so it is subtracted first and `stakeableCapital` is computed from
 * what remains AFTER both the cushion and the working budget, never from the
 * cushion itself. A staked cushion is not a cushion: exchange yield products
 * carry redemption delays that land precisely during the volatility that
 * creates the margin call.
 */

/** Every field is a fraction of total equity (0.25 = 25%), never a dollar amount. */
export interface AllocationPolicy {
  /** Working budget with no track record yet — the starting point of the adaptive band. */
  neutralWorkingPct: Big;
  /** Floor of the adaptive band — a losing streak can never shrink the working budget below this. */
  minWorkingPct: Big;
  /**
   * Ceiling of the adaptive band. MUST stay consistent with risk/leverage.ts's
   * CONCENTRATION_MAX once converted from capital to notional — see
   * `describeAllocationConflicts`, which checks exactly that rather than
   * leaving the two numbers to drift apart by hand.
   */
  maxWorkingPct: Big;
  /** One outcome's effect on the working budget. */
  stepPct: Big;
  /** Never deployed, never staked, always liquid. */
  cushionPct: Big;
  /** Cap on how much of total equity may sit in a yield product at once. */
  maxStakePct: Big;
  /**
   * When the working budget falls below this, the strategy is idling and more
   * of the deposit is genuinely spare — `maxStakePct` is raised to
   * `elevatedStakePct` for that case (the owner's "если используется меньше
   * 50% — в стейк до 35%" rule, generalized).
   */
  lowUtilizationThresholdPct: Big;
  elevatedStakePct: Big;
}

/**
 * Mirrors the owner's stated numbers. NOT the production default for
 * risk/ — `maxWorkingPct` here is 0.50, which converts to a 25% NOTIONAL
 * concentration at leverage 1.0 and therefore exactly matches
 * risk/leverage.ts's CONCENTRATION_MAX rather than exceeding it. Raising it
 * past that is a real risk decision, not a config tweak, and
 * `describeAllocationConflicts` will say so out loud.
 */
export const DEFAULT_ALLOCATION_POLICY: AllocationPolicy = {
  neutralWorkingPct: new Big("0.40"),
  minWorkingPct: new Big("0.30"),
  maxWorkingPct: new Big("0.50"),
  stepPct: new Big("0.05"),
  cushionPct: new Big("0.20"),
  maxStakePct: new Big("0.20"),
  lowUtilizationThresholdPct: new Big("0.40"),
  elevatedStakePct: new Big("0.35"),
};

/**
 * The owner's stated 80/20 split (2026-08-10): up to 80% of the deposit
 * working, the remaining 20% held as the cushion — and, by the owner's explicit
 * decision, that cushion IS the staked portion rather than sitting liquid
 * alongside one. Scales by construction: $1000 -> $800/$200, $2000 -> $1600/$400.
 *
 * NOT the shipped default, and deliberately so: `maxWorkingPct` 0.80 of CAPITAL
 * is 0.40 of equity in single-coin NOTIONAL at leverage 1.0, i.e. 1.6x
 * risk/leverage.ts's CONCENTRATION_MAX. `describeAllocationConflicts` reports
 * that against the real cap, and RiskThresholds.maxConcentration is what an
 * emulation raises to measure it — the production default stays at the
 * documented ТАБУ п.11 value until a real run says otherwise.
 *
 * Two properties of this split that the arithmetic makes non-obvious:
 *   - `cushionPct` here is BOTH cushion and stake, so `stakeableCapital` and
 *     `cushion` describe the same dollars under two names. At the top of the
 *     band there is no third liquid bucket left — a margin call has to be met
 *     out of the staked portion, whose redemption is not instant.
 *   - 0.80 of capital funds only 0.40 of equity in notional (the two-leg
 *     factor), so funding income is computed on $400 of a $1000 deposit, not
 *     $800.
 */
export const OWNER_80_20_POLICY: AllocationPolicy = {
  neutralWorkingPct: new Big("0.50"),
  minWorkingPct: new Big("0.40"),
  maxWorkingPct: new Big("0.80"),
  stepPct: new Big("0.05"),
  cushionPct: new Big("0.20"),
  maxStakePct: new Big("0.20"),
  lowUtilizationThresholdPct: new Big("0.50"),
  elevatedStakePct: new Big("0.35"),
};

export interface TradeResult {
  /** Signed realized P&L of one closed trade. */
  realizedPnl: Big;
  /** Total equity immediately after it closed — normalizes P&L to a percentage. */
  equityAtClose: Big;
}

export interface Allocation {
  totalEquity: Big;
  /** Dollars of CAPITAL the strategy may commit (both legs together). */
  workingCapital: Big;
  /**
   * Dollars of NOTIONAL per leg that `workingCapital` actually buys, after the
   * `(1 + 1/leverage)` two-leg cost. This — not workingCapital — is what
   * funding income accrues on.
   */
  maxNotional: Big;
  /** Liquid, never deployed, never staked. */
  cushion: Big;
  /** Neither working nor cushion — the only money a yield product may hold. */
  stakeableCapital: Big;
  /** Left liquid and unused: idle minus whatever the stake cap allows. */
  idleLiquid: Big;
  /** The working fraction this allocation resolved to, after replaying history. */
  workingPct: Big;
}

/**
 * Inverse of `capital = notional * (1 + 1/leverage)`. Exported because the
 * factor is the single easiest thing to get wrong when reasoning about this
 * strategy's returns by hand.
 */
export function notionalForCapital(capital: Big, leverage: Big): Big {
  if (leverage.lt(1)) {
    throw new RangeError(`leverage must be >= 1 (1.0 = fully self-funded), got ${leverage.toString()}`);
  }
  if (capital.lt(0)) {
    throw new RangeError(`capital must be non-negative, got ${capital.toString()}`);
  }
  return capital.div(new Big(1).plus(new Big(1).div(leverage)));
}

/**
 * Anti-martingale fold over closed trades, same direction and same rationale
 * as emulation/adaptivePositionSizing.ts (grow after a winning streak, shrink
 * after a significant loss — never the reverse), but expressed over an
 * arbitrary policy band instead of that module's fixed 5%/25% one.
 *
 * `history` must be chronological (oldest first); out-of-order input produces
 * a wrong-but-not-crashing answer, exactly as in adaptivePositionSizing.ts.
 */
export function computeWorkingPct(
  history: readonly TradeResult[],
  policy: AllocationPolicy,
  significantLossPctOfEquity: Big = new Big("0.03"),
): Big {
  let pct = policy.neutralWorkingPct;
  const lossBar = significantLossPctOfEquity.times(-1);

  for (let i = 0; i < history.length; i++) {
    const trade = history[i];
    if (!trade) continue; // satisfies noUncheckedIndexedAccess

    if (trade.equityAtClose.lte(0)) {
      // Dead or negative account has no meaningful percentage — treat exactly
      // as a significant loss, never as neutral. Same fail-closed direction as
      // adaptivePositionSizing.ts.
      pct = pct.minus(policy.stepPct);
    } else {
      const pnlPct = trade.realizedPnl.div(trade.equityAtClose);
      const previous = i > 0 ? history[i - 1] : undefined;
      const previousIsWin = previous !== undefined && previous.realizedPnl.gt(0);

      if (pnlPct.lt(lossBar)) {
        pct = pct.minus(policy.stepPct);
      } else if (trade.realizedPnl.gt(0) && previousIsWin) {
        pct = pct.plus(policy.stepPct);
      }
      // Ordinary loss, isolated win, or breakeven: no move. Only streaks count.
    }

    if (pct.lt(policy.minWorkingPct)) pct = policy.minWorkingPct;
    if (pct.gt(policy.maxWorkingPct)) pct = policy.maxWorkingPct;
  }

  return pct;
}

/**
 * Resolves the full split. Order matters and is not arbitrary: cushion first
 * (it is a liquidity guarantee, so it may not be competed for), working budget
 * second (bounded by both the policy band and what is left after the cushion),
 * yield allocation last and only out of the genuine remainder.
 */
export function computeAllocation(
  totalEquity: Big,
  history: readonly TradeResult[],
  policy: AllocationPolicy = DEFAULT_ALLOCATION_POLICY,
  leverage: Big = new Big("1"),
): Allocation {
  if (totalEquity.lte(0)) {
    throw new RangeError(`totalEquity must be positive, got ${totalEquity.toString()}`);
  }

  const workingPct = computeWorkingPct(history, policy);
  const cushion = totalEquity.times(policy.cushionPct);

  // Bounded by what actually remains, not just by the policy band: a policy
  // whose cushion + ceiling exceed 100% must not silently overdraw the
  // account. describeAllocationConflicts reports that as a config error, but
  // this function still has to behave sanely if it is called anyway.
  const requested = totalEquity.times(workingPct);
  const availableForWork = totalEquity.minus(cushion);
  const workingCapital = requested.gt(availableForWork) ? availableForWork : requested;

  const idle = totalEquity.minus(cushion).minus(workingCapital);

  // The owner's "if the strategy is barely using the deposit, let more of it
  // earn yield elsewhere" rule — keyed on the resolved working fraction.
  const stakeCapPct = workingPct.lt(policy.lowUtilizationThresholdPct)
    ? policy.elevatedStakePct
    : policy.maxStakePct;
  const stakeCap = totalEquity.times(stakeCapPct);
  const stakeableCapital = idle.gt(stakeCap) ? stakeCap : idle;

  return {
    totalEquity,
    workingCapital,
    maxNotional: notionalForCapital(workingCapital, leverage),
    cushion,
    stakeableCapital,
    idleLiquid: idle.minus(stakeableCapital),
    workingPct,
  };
}

/**
 * Static sanity check on a policy — returns human-readable problems, empty
 * array when clean. Exists so a policy that cannot physically hold (or that
 * silently contradicts risk/leverage.ts's hard caps) is caught at
 * configuration time rather than discovered as a stream of CONCENTRATION_EXCEEDED
 * vetoes at run time.
 *
 * `concentrationMax` must be passed in rather than imported so this module
 * stays free of a risk/ dependency (ARCHITECTURE.md §2 keeps risk/ as the
 * authority that strategy/ submits to, not a thing strategy/ reaches into).
 */
export function describeAllocationConflicts(
  policy: AllocationPolicy,
  concentrationMax: Big,
  leverage: Big = new Big("1"),
): string[] {
  const problems: string[] = [];

  if (policy.minWorkingPct.gt(policy.maxWorkingPct)) {
    problems.push(
      `minWorkingPct ${policy.minWorkingPct.toString()} exceeds maxWorkingPct ${policy.maxWorkingPct.toString()}.`,
    );
  }
  if (policy.neutralWorkingPct.lt(policy.minWorkingPct) || policy.neutralWorkingPct.gt(policy.maxWorkingPct)) {
    problems.push(
      `neutralWorkingPct ${policy.neutralWorkingPct.toString()} sits outside the band ` +
        `[${policy.minWorkingPct.toString()}, ${policy.maxWorkingPct.toString()}].`,
    );
  }

  const maxWorkPlusCushion = policy.maxWorkingPct.plus(policy.cushionPct);
  if (maxWorkPlusCushion.gt(1)) {
    problems.push(
      `maxWorkingPct + cushionPct = ${maxWorkPlusCushion.toString()} exceeds 100% of equity — ` +
        "at the top of the band the cushion would be overdrawn.",
    );
  }

  // The check this function primarily exists for: the working budget is
  // CAPITAL, the concentration cap is on NOTIONAL, and the two differ by the
  // two-leg factor. Comparing them directly (as a reader naturally would) is
  // exactly the mistake that makes an 80% working target look reasonable.
  const impliedNotionalPct = notionalForCapital(policy.maxWorkingPct, leverage);
  if (impliedNotionalPct.gt(concentrationMax)) {
    problems.push(
      `maxWorkingPct ${policy.maxWorkingPct.toString()} of capital implies ` +
        `${impliedNotionalPct.toString()} of equity as single-coin NOTIONAL at leverage ` +
        `${leverage.toString()}, over risk/leverage.ts's CONCENTRATION_MAX ${concentrationMax.toString()} ` +
        "(PARAMS-CONSERVATIVE.md §11, ТАБУ п.11) — every entry at the top of the band would be " +
        "vetoed with CONCENTRATION_EXCEEDED. Raising that cap is a risk decision, not a config tweak.",
    );
  }

  const maxStakeEver = policy.maxStakePct.gt(policy.elevatedStakePct)
    ? policy.maxStakePct
    : policy.elevatedStakePct;
  if (maxStakeEver.plus(policy.cushionPct).plus(policy.minWorkingPct).gt(1)) {
    problems.push(
      `At the bottom of the band, minWorkingPct + cushionPct + max stake = ` +
        `${policy.minWorkingPct.plus(policy.cushionPct).plus(maxStakeEver).toString()} exceeds 100%.`,
    );
  }

  return problems;
}
