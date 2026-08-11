import Big from "big.js";

/**
 * The FLATTEN_ALL escalation ladder from docs/FLATTEN-LADDER.md — transcribed
 * from that document (its §2 table and §3 escalation rule), not reconstructed
 * from memory, exactly as pairIntentState.ts transcribes ARCHITECTURE.md §4.
 * That document is the source of truth; this file is its implementation, not
 * the other way around.
 *
 * This module is PURE: no network, no DB, no exchange key. It decides WHAT the
 * supervisor should do next given the freshly-read exchange exposure, and it
 * decides when the job is done. Wiring these decisions to real
 * cancel/reduceOnly/sell I/O (against a Trade-permission key, on testnet first)
 * is a separate, later piece. Building the decision half now — ahead of the I/O
 * that will act on it — mirrors killswitch-listener.ts's own documented choice
 * to build the STATE half of the kill switch before there is anything live to
 * break. Today the project has no order-placement code, no Trade key, and no
 * live position at all (Phase 2, paper-trading): there is nothing to flatten,
 * so the contract is what gets built.
 *
 * THE ONE INVARIANT THIS MODULE EXISTS TO ENFORCE (docs/FLATTEN-LADDER.md §1,
 * RISK-REGISTER.md FM-30 / line 231): success is NEVER derived from control
 * flow. "The cancel-all request did not throw" is not "the position is closed."
 * Every decision below is a function of freshly-READ exposure, never of whether
 * a prior action's request happened to succeed. An action that returned without
 * error but did not change the exposure is not success — it is a reason to
 * escalate to the next rung.
 */

/**
 * The ladder rungs in order of increasing crudeness (docs/FLATTEN-LADDER.md §2).
 * Order is load-bearing: CANCEL_ALL is first for safety, not money — a resting
 * order that fills mid-flatten can open a fresh leg and leave the system worse
 * off than before the intervention.
 */
export type FlattenRung = "CANCEL_ALL" | "REDUCE_ONLY_CLOSE" | "SELL_SPOT";

export const LADDER: readonly FlattenRung[] = ["CANCEL_ALL", "REDUCE_ONLY_CLOSE", "SELL_SPOT"];

/**
 * A live derivatives position as read from `position/list` (RSK-50: the caller
 * must have exhausted `nextPageCursor` across every `settleCoin` before handing
 * these in — a "flat" verdict derived from a truncated list is exactly the
 * FM-30 failure this module refuses to make). `size` is the absolute contract
 * quantity as a decimal string; `side` is the direction of the open position,
 * so closing it means sending the OPPOSITE side reduceOnly.
 */
export interface PerpPosition {
  symbol: string;
  side: "Buy" | "Sell";
  /** Absolute position size, decimal string (Bybit wire format). Never a float. */
  size: string;
  /** Per-symbol market-order cap (FM-31) — read at startup, decimal string. */
  maxMktOrderQty: string;
  /** Per-symbol quantity step (lot size), decimal string — every slice but the remainder must be a multiple of this. */
  qtyStep: string;
}

/**
 * A spot balance ATTRIBUTED to this bot via the spot-ledger (RSK-47), not a raw
 * wallet balance. Un-attributed spot movement is a separate kill-switch-level
 * event (FM-48/RSK-48), not something this ladder sells. `dustThreshold` is the
 * per-coin rounding floor below which a residue is lot-rounding noise, not a
 * position (docs/FLATTEN-LADDER.md §5).
 */
export interface AttributedSpot {
  coin: string;
  /** Attributed free quantity, decimal string. Never a float. */
  qty: string;
  dustThreshold: string;
}

/**
 * The freshly-read exposure the whole contract keys off (docs/FLATTEN-LADDER.md
 * §1, §5). This is the ONLY input the decision functions trust — deliberately
 * NOT "what the last action reported."
 */
export interface Observation {
  perpPositions: readonly PerpPosition[];
  attributedSpot: readonly AttributedSpot[];
}

/**
 * The result of deriving "is anything still open?" from a fresh Observation
 * (docs/FLATTEN-LADDER.md §5). This is what gets written to `killswitch_run` as
 * the run's final `exposure_open`, and it is what decides CONFIRMED_FLAT vs
 * escalation — not any request's return value.
 */
export interface ExposureOpen {
  openPerps: readonly PerpPosition[];
  /** Attributed spot above its dust threshold — the balances SELL_SPOT still has to clear. */
  openSpot: readonly AttributedSpot[];
}

export function isFlat(exposure: ExposureOpen): boolean {
  return exposure.openPerps.length === 0 && exposure.openSpot.length === 0;
}

/**
 * FM-30, the load-bearing rule: derive open exposure from FRESH READS only.
 * A perp position counts as open when its size is non-zero; attributed spot
 * counts as open when it exceeds its per-coin dust threshold (lot-rounding
 * residue is not a position — docs/FLATTEN-LADDER.md §5). Throws on a malformed
 * numeric field rather than silently treating it as zero: a money/quantity
 * field that fails to parse is an RSK-56-class event, and quietly reading it as
 * "flat" is the precise mistake FM-30 forbids.
 */
export function deriveExposureOpen(obs: Observation): ExposureOpen {
  const openPerps = obs.perpPositions.filter((p) => {
    const size = new Big(p.size); // throws on malformed input — deliberately not caught
    if (size.lt(0)) {
      throw new Error(
        `deriveExposureOpen: negative position size "${p.size}" for ${p.symbol} — ` +
          `size is an absolute quantity (side carries direction); a negative value is a bug in the reader, not a short.`,
      );
    }
    return size.gt(0);
  });

  const openSpot = obs.attributedSpot.filter((s) => {
    const qty = new Big(s.qty); // throws on malformed input — deliberately not caught
    const dust = new Big(s.dustThreshold);
    if (qty.lt(0)) {
      throw new Error(
        `deriveExposureOpen: negative attributed spot qty "${s.qty}" for ${s.coin} — ` +
          `attributed spot is a floor invariant (RSK-47); a negative value means the ledger is broken, not that there is a short.`,
      );
    }
    if (dust.lt(0)) {
      throw new Error(`deriveExposureOpen: negative dustThreshold "${s.dustThreshold}" for ${s.coin} — misconfiguration.`);
    }
    return qty.gt(dust);
  });

  return { openPerps, openSpot };
}

/**
 * FM-31 / RSK-39: slice a reduceOnly market close into chunks that each respect
 * `maxMktOrderQty`. A single full-size emergency close is rejected or SILENTLY
 * TRUNCATED on 778 of 794 instruments (BTCUSDT: maxOrderQty 1500 vs
 * maxMktOrderQty 150) — precisely in the one scenario the mechanism exists for.
 *
 * Every chunk is <= maxMktOrderQty, the chunks sum to exactly totalQty, and
 * every chunk except a possible final remainder is a multiple of qtyStep (an
 * off-step quantity is rejected by the exchange). totalQty == 0 returns []
 * (nothing to close is not an error). A non-positive cap or step, or a negative
 * total, throws — that is a caller bug, not a recoverable case.
 */
export function sliceReduceOnly(totalQty: string, maxMktOrderQty: string, qtyStep: string): string[] {
  const total = new Big(totalQty);
  const cap = new Big(maxMktOrderQty);
  const step = new Big(qtyStep);

  if (total.lt(0)) {
    throw new Error(`sliceReduceOnly: negative totalQty "${totalQty}" — the caller passed a signed size where an absolute one is required.`);
  }
  if (cap.lte(0)) {
    throw new Error(`sliceReduceOnly: maxMktOrderQty must be positive, got "${maxMktOrderQty}" — a zero/negative cap cannot close anything.`);
  }
  if (step.lte(0)) {
    throw new Error(`sliceReduceOnly: qtyStep must be positive, got "${qtyStep}".`);
  }
  if (total.eq(0)) {
    return [];
  }

  // The largest whole-step quantity that still fits under the cap. If the cap
  // itself is smaller than one step the instrument is misconfigured for market
  // closes — surface it rather than emit an off-step chunk the exchange rejects.
  const stepsPerChunk = cap.div(step).round(0, Big.roundDown); // floor(cap/step)
  if (stepsPerChunk.lt(1)) {
    throw new Error(
      `sliceReduceOnly: maxMktOrderQty ${maxMktOrderQty} is smaller than one qtyStep ${qtyStep} for this symbol — ` +
        `no on-step chunk fits under the market-order cap; this instrument cannot be market-closed and needs operator handling.`,
    );
  }
  const chunk = stepsPerChunk.times(step); // largest on-step quantity <= cap

  const chunks: string[] = [];
  let remaining = total;
  // Guard against an accidental unbounded loop from a pathological input the
  // checks above somehow let through — the ladder must never hang the supervisor.
  const maxChunks = total.div(chunk).plus(2).round(0, Big.roundUp);
  let guard = new Big(0);
  while (remaining.gt(0)) {
    if (guard.gt(maxChunks)) {
      throw new Error(`sliceReduceOnly: slicing did not converge for totalQty=${totalQty}, cap=${maxMktOrderQty}, step=${qtyStep} — refusing to loop.`);
    }
    if (remaining.gte(chunk)) {
      chunks.push(chunk.toString());
      remaining = remaining.minus(chunk);
    } else {
      // Final remainder — below one full chunk. Emitted as-is: it is what is
      // left of the position, and forcing it onto the step grid here could
      // leave a residual open. Bybit rounds a reduceOnly close to the position
      // it is closing, so the true remainder is the correct last order.
      chunks.push(remaining.toString());
      remaining = new Big(0);
    }
    guard = guard.plus(1);
  }
  return chunks;
}

/**
 * A concrete instruction for the (later, live) supervisor. The pure ladder emits
 * these; the I/O layer executes them and then RE-READS to produce the next
 * Observation. No FlattenAction carries a "this succeeded" flag by design —
 * success is only ever re-derived from the next Observation (FM-30).
 */
export type FlattenAction =
  | { kind: "CANCEL_ALL"; category: "linear" | "spot" }
  | { kind: "REDUCE_ONLY_CLOSE"; symbol: string; closeSide: "Buy" | "Sell"; slices: string[] }
  | { kind: "SELL_SPOT"; coin: string; qty: string };

/**
 * The decision the pure ladder returns for one step. Either a concrete action
 * to perform on the current rung, or one of the two terminals from
 * docs/FLATTEN-LADDER.md §6.
 */
export type FlattenDecision =
  | { kind: "ACT"; rung: FlattenRung; actions: FlattenAction[] }
  | { kind: "CONFIRMED_FLAT"; exposure: ExposureOpen }
  | { kind: "NEEDS_OPERATOR"; exposure: ExposureOpen; reason: string };

/**
 * The next rung after `rung`, or null if `rung` is the last (SELL_SPOT).
 * Escalation is monotonic and never revisits an earlier rung within one run —
 * docs/FLATTEN-LADDER.md §3.
 */
export function nextRung(rung: FlattenRung): FlattenRung | null {
  const i = LADDER.indexOf(rung);
  if (i < 0) {
    throw new Error(`nextRung: "${rung}" is not a ladder rung.`);
  }
  return LADDER[i + 1] ?? null;
}

/**
 * THE decision function (docs/FLATTEN-LADDER.md §3). Pure: given the freshly-read
 * exposure and which rungs have already been attempted this run, decide the next
 * step. It never inspects whether a prior action "succeeded" — only the
 * Observation (FM-30).
 *
 * Rules, in order:
 *  1. If a fresh read shows flat, we are done — CONFIRMED_FLAT — regardless of
 *     what any prior rung did or whether it threw.
 *  2. Otherwise walk the ladder from the top, skipping rungs already attempted,
 *     and emit the first rung that has work to do for the CURRENT exposure:
 *       - CANCEL_ALL: always has work if not yet attempted (we cannot see resting
 *         orders in an Observation, and cancelling is safe/idempotent — so it is
 *         attempted once, unconditionally, before touching positions).
 *       - REDUCE_ONLY_CLOSE: has work iff there are open perps.
 *       - SELL_SPOT: has work iff there is open attributed spot.
 *     A rung with no work for the current exposure is marked attempted and
 *     skipped (returning its "no work" does not consume an escalation step
 *     wrongly — the caller records it attempted and calls again).
 *  3. If every rung has been attempted and the read still shows exposure, the
 *     automation is exhausted — NEEDS_OPERATOR. This is not "we failed"; it is
 *     "a human takes over now," the same terminal role STUCK_LEG plays in
 *     pairIntentState.
 *
 * `attempted` is the set of rungs already tried this run. The caller adds a rung
 * to it after performing (or skipping) that rung, then re-reads and calls again
 * — this is how the FM-30 "act, then re-derive from a fresh read" loop is driven
 * without this function ever holding I/O state.
 */
export function decideFlattenStep(obs: Observation, attempted: ReadonlySet<FlattenRung>): FlattenDecision {
  const exposure = deriveExposureOpen(obs);

  // Rule 1: a fresh read showing flat is the only thing that ends the run
  // successfully — checked FIRST, before any rung, so a close that worked is
  // recognised no matter which rung produced it.
  if (isFlat(exposure)) {
    return { kind: "CONFIRMED_FLAT", exposure };
  }

  // Rule 2: first not-yet-attempted rung that has work for the current exposure.
  for (const rung of LADDER) {
    if (attempted.has(rung)) continue;

    if (rung === "CANCEL_ALL") {
      // Attempted once, unconditionally: resting orders are invisible in an
      // Observation, cancelling is safe and idempotent, and it must precede any
      // market close (docs/FLATTEN-LADDER.md §2). Both categories in one step.
      return {
        kind: "ACT",
        rung,
        actions: [
          { kind: "CANCEL_ALL", category: "linear" },
          { kind: "CANCEL_ALL", category: "spot" },
        ],
      };
    }

    if (rung === "REDUCE_ONLY_CLOSE") {
      if (exposure.openPerps.length === 0) continue; // no work — skip, caller marks attempted
      const actions: FlattenAction[] = exposure.openPerps.map((p) => ({
        kind: "REDUCE_ONLY_CLOSE" as const,
        symbol: p.symbol,
        // Close the OPPOSITE side of the open position (RSK-39 / §4).
        closeSide: p.side === "Buy" ? ("Sell" as const) : ("Buy" as const),
        slices: sliceReduceOnly(p.size, p.maxMktOrderQty, p.qtyStep),
      }));
      return { kind: "ACT", rung, actions };
    }

    // rung === "SELL_SPOT"
    if (exposure.openSpot.length === 0) continue; // no work — skip, caller marks attempted
    const actions: FlattenAction[] = exposure.openSpot.map((s) => ({
      kind: "SELL_SPOT" as const,
      coin: s.coin,
      qty: s.qty,
    }));
    return { kind: "ACT", rung, actions };
  }

  // Rule 3: ladder exhausted, exposure remains — hand off to the operator.
  return {
    kind: "NEEDS_OPERATOR",
    exposure,
    reason:
      "FLATTEN_ALL ladder exhausted (cancel-all, reduceOnly close, sell spot all attempted) " +
      "and a fresh position/list + wallet-balance read still shows open exposure. " +
      "Automation is done; manual operator intervention is required (docs/FLATTEN-LADDER.md §6).",
  };
}
