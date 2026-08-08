import Big from "big.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  runScenario,
  DEFAULT_PERP_QTY_STEP,
  SPOT_TAKER_FEE_RATE_FALLBACK,
  PERP_TAKER_FEE_RATE_FALLBACK,
} from "../../src/emulation/scenarioRunner.js";
import {
  computeNextPositionSizeFraction,
  NO_HISTORY_FRACTION,
  SIGNIFICANT_LOSS_THRESHOLD_PCT_OF_EQUITY,
} from "../../src/emulation/adaptivePositionSizing.js";
import { computeRealizedPnl } from "../../src/execution/realizedPnl.js";
import { sizePosition } from "../../src/strategy/sizing.js";
import { createDb } from "../../src/storage/db.js";
import type { Database } from "../../src/storage/schema.js";

/**
 * Real local/test Postgres required (same pattern as
 * test/market-data/collectionDigest.test.ts) — DATABASE_URL must point at a
 * migrated instance. No skip on a missing DATABASE_URL: a silently-skipped
 * test that never ran is worse than a loud failure (PROJECT.md's "ни одного
 * проглоченного исключения" ethos, applied to test infrastructure too).
 */

const ALL_TEST_SYMBOLS = [
  "__TEST_SCN_LOOKAHEAD__USDT",
  "__TEST_SCN_INTERVAL240__USDT",
  "__TEST_SCN_MULTIA__USDT",
  "__TEST_SCN_MULTIB__USDT",
  "__TEST_SCN_MULTIC__USDT",
  "__TEST_SCN_EXITPLANNED__USDT",
  "__TEST_SCN_LIQUIDATION__USDT",
  "__TEST_SCN_ADAPT_A__USDT",
  "__TEST_SCN_ADAPT_B__USDT",
];

const DEEP_BOOK_QTY = "100000"; // $10,000,000 notional at price=100 — far more than any test's ~$100 targetNotional, so slippageBp stays exactly 0.
const GENEROUS_TURNOVER = "500000000"; // above both PARAMS-CONSERVATIVE.md §4 floors (perp 100M, spot 20M)

async function insertTickerPair(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  price: string,
): Promise<void> {
  await db
    .insertInto("tickers")
    .values([
      {
        symbol,
        category: "linear",
        last_price: price,
        mark_price: price,
        index_price: price,
        volume_24h: null,
        turnover_24h: GENEROUS_TURNOVER,
        fetched_at: fetchedAt,
      },
      {
        symbol,
        category: "spot",
        last_price: price,
        mark_price: null,
        index_price: null,
        volume_24h: null,
        turnover_24h: GENEROUS_TURNOVER,
        fetched_at: fetchedAt,
      },
    ])
    .execute();
}

async function insertDeepBook(db: Kysely<Database>, symbol: string, fetchedAt: Date, price: string): Promise<void> {
  await db
    .insertInto("orderbook_levels")
    .values([
      { symbol, category: "linear", side: "bid", level_index: 0, price, qty: DEEP_BOOK_QTY, fetched_at: fetchedAt },
      { symbol, category: "spot", side: "ask", level_index: 0, price, qty: DEEP_BOOK_QTY, fetched_at: fetchedAt },
    ])
    .execute();
}

async function insertPredictedFunding(
  db: Kysely<Database>,
  symbol: string,
  fetchedAt: Date,
  rate: string,
  nextFundingAt: Date,
  intervalMinutes = 480,
): Promise<void> {
  await db
    .insertInto("funding_rates")
    .values({
      symbol,
      kind: "predicted",
      rate,
      interval_minutes: intervalMinutes,
      funding_timestamp_ms: String(nextFundingAt.getTime()),
      fetched_at: fetchedAt,
    })
    .execute();
}

async function cleanupScenario(db: Kysely<Database>, scenarioId: bigint): Promise<void> {
  const positions = await db
    .selectFrom("paper_positions")
    .select("id")
    .where("scenario_id", "=", scenarioId)
    .execute();
  const positionIds = positions.map((p) => p.id);
  if (positionIds.length > 0) {
    await db.deleteFrom("paper_fills").where("position_id", "in", positionIds).execute();
    await db.deleteFrom("paper_funding_payments").where("position_id", "in", positionIds).execute();
  }
  await db.deleteFrom("paper_equity_snapshots").where("scenario_id", "=", scenarioId).execute();
  await db.deleteFrom("paper_positions").where("scenario_id", "=", scenarioId).execute();
  await db.deleteFrom("paper_scenarios").where("id", "=", scenarioId).execute();
}

describe("runScenario", () => {
  let db: Kysely<Database>;
  const scenarioIdsToClean: bigint[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    db = createDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    for (const id of scenarioIdsToClean.splice(0)) {
      await cleanupScenario(db, id);
    }
    await db.deleteFrom("tickers").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
    await db.deleteFrom("funding_rates").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
    await db.deleteFrom("orderbook_levels").where("symbol", "in", ALL_TEST_SYMBOLS).execute();
  });

  afterAll(async () => db.destroy());

  it(
    "never opens a position on a predicted rate that only turns favorable partway through the range, even though a " +
      "settled row for the SAME event (with an earlier funding_timestamp_ms) is already in the table from the start " +
      "— proves entry decisions read kind='predicted' at the tick's own fetched_at, never kind='settled' (look-ahead)",
    async () => {
      const symbol = "__TEST_SCN_LOOKAHEAD__USDT";
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const t1 = new Date("2026-01-01T01:00:00.000Z");
      const t2 = new Date("2026-01-01T02:00:00.000Z"); // the tick where the predicted rate turns favorable
      const t3 = new Date("2026-01-01T03:00:00.000Z");
      const t4 = new Date("2026-01-01T04:00:00.000Z");
      const ticks = [t0, t1, t2, t3, t4];

      // provably-below-floor: below both ENTRY_FLOOR_R8H (0.0002) and the
      // premium-driven gate (0.0005) — risk/index.ts must deny every candidate here.
      const LOW_RATE = "0.0001";
      // provably-above-floor: comfortably clears both gates AND the K=2.0
      // round-trip payback threshold at expectedHoldIntervals=9 (3 days / 8h).
      const HIGH_RATE = "0.001";
      const PRICE = "100";

      for (const t of ticks) {
        await insertTickerPair(db, symbol, t, PRICE);
      }
      await insertDeepBook(db, symbol, t0, PRICE);

      // Predicted rate: LOW at t0/t1, flips to HIGH exactly at t2 and stays HIGH.
      const nextFunding = (t: Date) => new Date(t.getTime() + 6 * 60 * 60 * 1000); // 6h out — outside FUNDING_SETTLEMENT_BLACKOUT
      await insertPredictedFunding(db, symbol, t0, LOW_RATE, nextFunding(t0));
      await insertPredictedFunding(db, symbol, t1, LOW_RATE, nextFunding(t1));
      await insertPredictedFunding(db, symbol, t2, HIGH_RATE, nextFunding(t2));
      await insertPredictedFunding(db, symbol, t3, HIGH_RATE, nextFunding(t3));
      await insertPredictedFunding(db, symbol, t4, HIGH_RATE, nextFunding(t4));

      // THE TRAP: a settled row for an event that, per its funding_timestamp_ms,
      // "happened" BEFORE t0 (before the scenario even starts) — but carries the
      // HIGH rate. A buggy entry path that consulted kind='settled' instead of (or
      // in addition to) kind='predicted' would see a favorable rate from the very
      // first tick. The correct implementation never reads kind='settled' for an
      // entry decision at all.
      await db
        .insertInto("funding_rates")
        .values({
          symbol,
          kind: "settled",
          rate: HIGH_RATE,
          interval_minutes: 480,
          funding_timestamp_ms: String(t0.getTime() - 60 * 60 * 1000),
          fetched_at: t0,
        })
        .execute();

      const result = await runScenario(db, {
        name: "__test_lookahead__",
        leverage: new Big("1"),
        startingDeposit: new Big("500"),
        symbols: [symbol],
        startAt: t0,
        endAt: t4,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.ticksProcessed).toBe(5);
      expect(result.positionsOpened).toBe(1);
      expect(result.positionsClosed).toBe(1); // force-closed at range end (t4) — no exit trigger fires before then

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(positions).toHaveLength(1);
      const position = positions[0]!;
      expect(position.symbol).toBe(symbol);

      // closePosition persists both real per-trade cost figures (not left only
      // in-memory — see reportGenerator.ts's dependency on these columns). Both
      // are exactly "0" in THIS fixture specifically: DEEP_BOOK_QTY makes
      // estimateSlippage's slippageBp exactly 0, and leverage=1 makes
      // computeBorrowCost8h's borrowed fraction exactly 0 by construction
      // (emulation/borrowCost.ts's own doc comment) — not a null/missing value.
      expect(position.slippage_cost).not.toBeNull();
      expect(new Big(position.slippage_cost!).toString()).toBe("0");
      expect(position.borrow_cost).not.toBeNull();
      expect(new Big(position.borrow_cost!).toString()).toBe("0");

      // entry_reasoning now also captures open_interest/long_short_ratio context
      // at entry (owner's ask, 2026-08-06: "что происходило на рынке") — "n/a"
      // here specifically because this fixture never inserts open_interest/
      // long_short_ratio rows at all, proving their absence is tolerated
      // (context-only, never a veto input — see evaluateCandidate) rather than
      // silently dropped from the string.
      expect(position.entry_reasoning).not.toBeNull();
      expect(position.entry_reasoning).toContain("r8h=0.001"); // HIGH_RATE, the rate active at t2
      expect(position.entry_reasoning).toContain("openInterest=n/a");
      expect(position.entry_reasoning).toContain("lsrBuyRatio=n/a");
      expect(position.entry_reasoning).toContain("lsrSellRatio=n/a");

      // exit_reasoning: symmetric to entry_reasoning (closePosition). This
      // position is force-closed at range end (t4), never a strategy/
      // exitRules.ts trigger — reasonCode=SCENARIO_END, held t2->t4 = 2h, and
      // the funding rate/basis actually in effect at the close tick.
      expect(position.exit_reasoning).not.toBeNull();
      expect(position.exit_reasoning).toContain("reasonCode=SCENARIO_END");
      expect(position.exit_reasoning).toContain("r8hAtExit=0.001"); // HIGH_RATE, still active at t4
      expect(position.exit_reasoning).toContain("heldHours=2.00");
      expect(position.exit_reasoning).not.toContain("liquidationPrice="); // only present for FORCED_LIQUIDATION

      // The core assertion: opened_at is t2 (first tick the PREDICTED rate turned
      // favorable) — never t0 or t1, despite the settled row's earlier timestamp.
      expect(position.opened_at).not.toBeNull();
      expect(position.opened_at?.getTime()).toBe(t2.getTime());
      expect(position.opened_at?.getTime()).toBeGreaterThan(t1.getTime());

      // Redundant-but-explicit: zero positions with any opened_at before t2.
      const prematureOpens = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .where("opened_at", "<", t2)
        .execute();
      expect(prematureOpens).toHaveLength(0);

      const scenarioRow = await db
        .selectFrom("paper_scenarios")
        .selectAll()
        .where("id", "=", result.scenarioId)
        .executeTakeFirst();
      expect(scenarioRow?.status).toBe("completed");
      expect(scenarioRow?.stopped_at).not.toBeNull();

      const snapshots = await db
        .selectFrom("paper_equity_snapshots")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      // Exactly 6: one writeEquitySnapshot per tick in the loop (ticksProcessed=5,
      // see line 187) + one more from the post-loop force-close block (t4 is
      // still open at loop-end per the SCENARIO_END/heldHours=2.00 assertions
      // above), so a regression that dropped the post-loop snapshot write would
      // silently pass a >=5 bound — pin the exact count instead.
      expect(snapshots.length).toBe(6);
    },
  );

  it(
    "denies entry on a 240-minute-interval symbol whose TRUE expected gross funding income (r8h normalized to the " +
      "8h basis, held for the constant 9-period 3-day payback window) does not clear 2x round-trip cost — regression " +
      "test for a bug (found 2026-08-07) where expectedHoldIntervals was computed from the symbol's own RAW " +
      "intervalMinutes instead of the r8h reference basis (480min), inflating expectedGross 2x for every 240min " +
      "symbol (the bulk of the live universe) and silently halving the intended K=2.0 safety margin",
    async () => {
      const symbol = "__TEST_SCN_INTERVAL240__USDT";
      const t0 = new Date("2026-03-01T00:00:00.000Z");
      const t1 = new Date("2026-03-01T01:00:00.000Z");
      const PRICE = "100";
      const nextFunding = new Date(t0.getTime() + 6 * 60 * 60 * 1000); // outside FUNDING_SETTLEMENT_BLACKOUT

      // Raw 240min-interval rate chosen so r8h = rate * 480/240 = 0.0006 —
      // comfortably above both ENTRY_FLOOR_R8H (0.0002) and the premium-driven
      // gate (0.0005), isolating checkEntryThreshold's EXPECTED_GROSS_TOO_LOW
      // as the only veto that can fire. With VIP0 fallback fees (spot 0.10% x2
      // + perp 0.055% x2 = totalRoundTripCost 0.0031, zero slippage/basis in
      // this fixture): correct expectedGross = r8h * 9 = 0.0054, which is
      // BELOW 2*0.0031=0.0062 (correctly denied). The pre-fix bug would have
      // computed expectedHoldIntervals = 4320/240 = 18 instead of the correct
      // 4320/480 = 9, giving expectedGross = r8h * 18 = 0.0108 — WELL above
      // 0.0062, wrongly allowing the entry.
      const RATE = "0.0003";

      await insertTickerPair(db, symbol, t0, PRICE);
      await insertTickerPair(db, symbol, t1, PRICE);
      await insertDeepBook(db, symbol, t0, PRICE);
      await insertPredictedFunding(db, symbol, t0, RATE, nextFunding, 240);
      await insertPredictedFunding(db, symbol, t1, RATE, nextFunding, 240);

      const result = await runScenario(db, {
        name: "__test_interval240__",
        leverage: new Big("1"),
        startingDeposit: new Big("500"),
        symbols: [symbol],
        startAt: t0,
        endAt: t1,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.positionsOpened).toBe(0);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(positions).toHaveLength(0);
    },
  );

  it(
    "opens exactly ONE position when multiple symbols qualify at the same tick (RR-22), and it is the top-ranked " +
      "candidate by yieldOnEquity — proves strategy/rankCandidates.ts integration, not just single-symbol plumbing",
    async () => {
      const symA = "__TEST_SCN_MULTIA__USDT"; // highest rate -> highest yield -> must win
      const symB = "__TEST_SCN_MULTIB__USDT";
      const symC = "__TEST_SCN_MULTIC__USDT";
      const symbols = [symA, symB, symC];

      const t0 = new Date("2026-02-01T00:00:00.000Z");
      const t1 = new Date("2026-02-01T01:00:00.000Z");
      const PRICE = "100";
      const nextFunding = new Date(t0.getTime() + 6 * 60 * 60 * 1000);

      for (const symbol of symbols) {
        await insertTickerPair(db, symbol, t0, PRICE);
        await insertDeepBook(db, symbol, t0, PRICE);
      }
      // All three clear every risk/index.ts gate, but at DIFFERENT r8h rates —
      // deterministic ranking: A > B > C.
      await insertPredictedFunding(db, symA, t0, "0.0015", nextFunding);
      await insertPredictedFunding(db, symB, t0, "0.0012", nextFunding);
      await insertPredictedFunding(db, symC, t0, "0.0010", nextFunding);

      const result = await runScenario(db, {
        name: "__test_max_one_position__",
        leverage: new Big("1"),
        startingDeposit: new Big("500"),
        symbols: [symC, symA, symB], // deliberately NOT in rank order — proves ranking, not array order, decides the winner
        startAt: t0,
        endAt: t1,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.positionsOpened).toBe(1);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();

      // RR-22: exactly one row, never one per qualifying symbol.
      expect(positions).toHaveLength(1);
      expect(positions[0]!.symbol).toBe(symA);
    },
  );

  it(
    "closes a position via strategy/exitRules.ts's planned-exit path (checkExit -> exitDecision.shouldExit inside " +
      "processOpenPositionTick) when basis divergence exceeds PARAMS-CONSERVATIVE.md §7.3's threshold mid-hold — " +
      "every other fixture in this file only ever force-closes via the post-loop SCENARIO_END path, never this one",
    async () => {
      const symbol = "__TEST_SCN_EXITPLANNED__USDT";
      const t0 = new Date("2026-03-01T00:00:00.000Z");
      const t1 = new Date("2026-03-01T01:00:00.000Z");
      const PRICE = "100";
      const nextFunding = new Date(t0.getTime() + 6 * 60 * 60 * 1000);

      await insertTickerPair(db, symbol, t0, PRICE);
      await insertDeepBook(db, symbol, t0, PRICE);
      await insertPredictedFunding(db, symbol, t0, "0.001", nextFunding); // HIGH_RATE from the lookahead fixture above — clears every entry gate

      // t1: perp mark price UNCHANGED at 100 (leverage=1 puts the liquidation
      // price far away at ~196, so this can never accidentally liquidate
      // first) but spot moves to 98 — basis = (100-98)/98 = 0.0204, over
      // strategy/exitRules.ts's 0.005 BASIS_DIVERGENCE_THRESHOLD. Inserted
      // directly (not via insertTickerPair, which forces both legs to the
      // same price) specifically to diverge the two legs and prove
      // processOpenPositionTick recomputes currentBasis FRESH from this
      // tick's own prices, not the (0) basis captured at entry.
      await db
        .insertInto("tickers")
        .values([
          {
            symbol,
            category: "linear",
            last_price: PRICE,
            mark_price: PRICE,
            index_price: PRICE,
            volume_24h: null,
            turnover_24h: GENEROUS_TURNOVER,
            fetched_at: t1,
          },
          {
            symbol,
            category: "spot",
            last_price: "98",
            mark_price: null,
            index_price: null,
            volume_24h: null,
            turnover_24h: GENEROUS_TURNOVER,
            fetched_at: t1,
          },
        ])
        .execute();

      const result = await runScenario(db, {
        name: "__test_exit_planned__",
        leverage: new Big("1"),
        startingDeposit: new Big("500"),
        symbols: [symbol],
        startAt: t0,
        endAt: t1,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.ticksProcessed).toBe(2);
      expect(result.positionsOpened).toBe(1);
      expect(result.positionsClosed).toBe(1);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(positions).toHaveLength(1);
      const position = positions[0]!;

      // The core assertion: closed AT t1 (mid-range, not the last tick of a
      // longer range) via checkExit's BASIS_DIVERGED reason — proves the
      // wiring between exitDecision and closePosition (correct exitPerpPrice/
      // exitSpotPrice/reasonCode for this path), not the post-loop force-close.
      expect(position.opened_at?.getTime()).toBe(t0.getTime());
      expect(position.closed_at?.getTime()).toBe(t1.getTime());
      expect(position.exit_reasoning).not.toBeNull();
      expect(position.exit_reasoning).toContain("reasonCode=BASIS_DIVERGED");
      expect(position.exit_reasoning).not.toContain("reasonCode=SCENARIO_END");
      expect(position.exit_reasoning).not.toContain("liquidationPrice="); // only FORCED_LIQUIDATION sets this
    },
  );

  it(
    "closes a position via emulation/liquidation.ts's simulateDeltaNeutralForcedLiquidation (wasLiquidated=true, " +
      "inside processOpenPositionTick) when the perp mark price crosses the short leg's own liquidation price mid-" +
      "hold — the other close path every other fixture in this file never reaches",
    async () => {
      const symbol = "__TEST_SCN_LIQUIDATION__USDT";
      const t0 = new Date("2026-04-01T00:00:00.000Z");
      const t1 = new Date("2026-04-01T01:00:00.000Z");
      const ENTRY_PRICE = "100";
      const nextFunding = new Date(t0.getTime() + 6 * 60 * 60 * 1000);

      await insertTickerPair(db, symbol, t0, ENTRY_PRICE);
      await insertDeepBook(db, symbol, t0, ENTRY_PRICE);
      await insertPredictedFunding(db, symbol, t0, "0.001", nextFunding); // HIGH_RATE — clears every entry gate

      // 10x isolated margin leverage on the perp leg (ScenarioConfig.leverage
      // — NOT risk/leverage.ts's separate shortNotional/equity "effective
      // leverage" cap, which stays far under its own 1.5x ceiling regardless
      // of this value). This symbol is unknown to both KNOWN_MARGIN_TIERS and
      // FETCHED_MARGIN_TIERS, so lookupMarginTier falls back to
      // FALLBACK_CONSERVATIVE_TIER (MMR=2%, mmDeduction=0), putting
      // computeLiquidationPriceShort's short-leg liquidation price at exactly
      // entryPrice*(1+1/leverage)/(1+MMR) = 100*1.1/1.02 ≈ 107.84 (qty and
      // mmDeduction cancel out of that ratio exactly — see
      // computeLiquidationPriceShort's own doc comment). A mark price of 110
      // at t1 is comfortably above it, regardless of any qty-step rounding
      // sizePosition applied at entry.
      await insertTickerPair(db, symbol, t1, "110");
      // Without this, the position closed by forced liquidation above would
      // immediately re-qualify for a FRESH entry within this same tick t1:
      // executeScenario falls through to pickBestCandidate right after a
      // close (see its own comment on RR-22), and the t0 predicted-funding
      // row above is still "latest at or before t1" (nothing newer exists),
      // so the exact same HIGH_RATE signal that justified the original entry
      // would justify a second one — correct, look-ahead-safe behavior, but
      // not what this test is isolating. A fresh, floor-failing predicted
      // rate exactly at t1 supersedes it and keeps this test to the single
      // liquidation close path it names.
      await insertPredictedFunding(db, symbol, t1, "0.00001", nextFunding);

      const result = await runScenario(db, {
        name: "__test_forced_liquidation__",
        leverage: new Big("10"),
        startingDeposit: new Big("500"),
        symbols: [symbol],
        startAt: t0,
        endAt: t1,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.ticksProcessed).toBe(2);
      expect(result.positionsOpened).toBe(1);
      expect(result.positionsClosed).toBe(1);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .execute();
      expect(positions).toHaveLength(1);
      const position = positions[0]!;

      // The core assertion: closed AT t1 via the forced-liquidation branch —
      // proves the wiring between liqSim.wasLiquidated and closePosition
      // (reasonCode=FORCED_LIQUIDATION, and specifically pos.perpBankruptcyPrice
      // as the exit fill price, not the t1 mark price itself).
      expect(position.opened_at?.getTime()).toBe(t0.getTime());
      expect(position.closed_at?.getTime()).toBe(t1.getTime());
      expect(position.exit_reasoning).not.toBeNull();
      expect(position.exit_reasoning).toContain("reasonCode=FORCED_LIQUIDATION");
      expect(position.exit_reasoning).not.toContain("reasonCode=SCENARIO_END");
      expect(position.exit_reasoning).toContain("liquidationPrice="); // only FORCED_LIQUIDATION sets this
    },
  );

  it(
    "threads THIS scenario's own closed-trade history into computeNextPositionSizeFraction across two SEQUENTIAL " +
      "trades in one live run — every other fixture in this file only ever closes its single position via the " +
      "post-loop SCENARIO_END path, so computeNextPositionSizeFraction is never called here with anything but an " +
      "empty closedTradeHistory; adaptivePositionSizing.test.ts's own unit tests already prove the pure function " +
      "is correct in isolation, but never touch scenarioRunner.ts's own construction/threading of that history " +
      "into a real pickBestCandidate -> evaluateCandidate -> targetNotional call",
    async () => {
      const symA = "__TEST_SCN_ADAPT_A__USDT";
      const symB = "__TEST_SCN_ADAPT_B__USDT";
      const t0 = new Date("2026-05-01T00:00:00.000Z");
      const t1 = new Date("2026-05-01T01:00:00.000Z");
      const t2 = new Date("2026-05-01T02:00:00.000Z");
      const t3 = new Date("2026-05-01T03:00:00.000Z");
      const PRICE = "100";
      const RATE = "0.001"; // HIGH_RATE from the look-ahead fixture — comfortably clears every risk/index.ts gate
      const startingDeposit = new Big("500");
      const leverage = new Big("1");
      const nextFunding = (t: Date) => new Date(t.getTime() + 6 * 60 * 60 * 1000); // 6h out, outside FUNDING_SETTLEMENT_BLACKOUT

      // --- Symbol A: opens at t0 with an EMPTY closedTradeHistory (this
      // scenario's very first entry) -> NO_HISTORY_FRACTION (0.10). At t1 the
      // perp mark price jumps 50% (100 -> 150) while spot stays put — basis
      // divergence 0.50 >> exitRules.ts's 0.005 threshold, so checkExit
      // force-closes it immediately via BASIS_DIVERGED (unconditional, no
      // minimum-hold gate, unlike the funding-turned-negative/hysteresis
      // reasons — same mechanism as the "closes a position via
      // strategy/exitRules.ts's planned-exit path" fixture above, just a much
      // bigger jump). 150 stays safely below this position's own ~196
      // liquidation price (entryPrice*(1+1/leverage)/(1+MMR) = 100*2/1.02,
      // FALLBACK_CONSERVATIVE_TIER's 2% MMR at leverage=1 — same formula the
      // forced-liquidation fixture above documents), so FORCED_LIQUIDATION
      // never preempts the basis check. The resulting loss is deliberately
      // far past SIGNIFICANT_LOSS_THRESHOLD_PCT_OF_EQUITY (3%) so
      // computeNextPositionSizeFraction's step-down branch is unambiguously
      // the one exercised, not the "ordinary loss, no adjustment" branch.
      await insertTickerPair(db, symA, t0, PRICE);
      await insertDeepBook(db, symA, t0, PRICE);
      await insertPredictedFunding(db, symA, t0, RATE, nextFunding(t0));
      const exitPerpPriceA = new Big("150");
      await db
        .insertInto("tickers")
        .values([
          {
            symbol: symA,
            category: "linear",
            last_price: exitPerpPriceA.toString(),
            mark_price: exitPerpPriceA.toString(),
            index_price: exitPerpPriceA.toString(),
            volume_24h: null,
            turnover_24h: GENEROUS_TURNOVER,
            fetched_at: t1,
          },
          {
            symbol: symA,
            category: "spot",
            last_price: PRICE,
            mark_price: null,
            index_price: null,
            volume_24h: null,
            turnover_24h: GENEROUS_TURNOVER,
            fetched_at: t1,
          },
        ])
        .execute();

      // --- Symbol B: deliberately carries NO data at all until t2 — it
      // cannot possibly qualify before A's trade has already closed and been
      // pushed onto closedTradeHistory. This is what forces B's own entry
      // sizing decision to run with a NONEMPTY history, the exact gap this
      // test exists to close.
      await insertTickerPair(db, symB, t2, PRICE);
      await insertTickerPair(db, symB, t3, PRICE); // flat basis through range end -> SCENARIO_END close, not a premature exit
      await insertDeepBook(db, symB, t2, PRICE);
      await insertPredictedFunding(db, symB, t2, RATE, nextFunding(t2));

      const result = await runScenario(db, {
        name: "__test_adaptive_sizing_threading__",
        leverage,
        startingDeposit,
        symbols: [symA, symB],
        startAt: t0,
        endAt: t3,
      });
      scenarioIdsToClean.push(result.scenarioId);

      expect(result.ticksProcessed).toBe(4);
      expect(result.positionsOpened).toBe(2);
      expect(result.positionsClosed).toBe(2);

      const positions = await db
        .selectFrom("paper_positions")
        .selectAll()
        .where("scenario_id", "=", result.scenarioId)
        .orderBy("opened_at", "asc")
        .execute();
      expect(positions).toHaveLength(2);
      const posA = positions[0]!;
      const posB = positions[1]!;
      expect(posA.symbol).toBe(symA);
      expect(posB.symbol).toBe(symB);
      expect(posA.exit_reasoning).toContain("reasonCode=BASIS_DIVERGED");
      expect(posB.exit_reasoning).toContain("reasonCode=SCENARIO_END");

      // --- Trade 1's own actual size: empty history -> NO_HISTORY_FRACTION.
      const perpQtyA = new Big(posA.perp_qty!);
      const spotQtyA = new Big(posA.spot_qty!);
      expect(perpQtyA.toString()).toBe(spotQtyA.toString()); // RSK-07/08, 1:1
      const expectedSizingA = sizePosition({
        targetNotional: startingDeposit.times(NO_HISTORY_FRACTION),
        markPrice: new Big(PRICE),
        perpQtyStep: DEFAULT_PERP_QTY_STEP,
      });
      if (!expectedSizingA.allowed) throw new Error("fixture bug: symbol A's own entry should be allowed");
      expect(perpQtyA.toString()).toBe(expectedSizingA.perpQty.toString());

      // --- Independently reconstruct trade 1's realized outcome using the
      // SAME shared pure function scenarioRunner.ts's own closePosition calls
      // (execution/realizedPnl.ts's computeRealizedPnl), fed only with this
      // fixture's own controlled inputs — not a hand-typed dollar figure.
      const initialCapitalA = spotQtyA.times(PRICE).plus(perpQtyA.times(PRICE).div(leverage));
      const cashOutsideAfterOpenA = startingDeposit.minus(initialCapitalA);
      const entryFeesA = spotQtyA
        .times(PRICE)
        .times(SPOT_TAKER_FEE_RATE_FALLBACK)
        .plus(perpQtyA.times(PRICE).times(PERP_TAKER_FEE_RATE_FALLBACK));
      const exitFeesA = spotQtyA
        .times(PRICE)
        .times(SPOT_TAKER_FEE_RATE_FALLBACK)
        .plus(perpQtyA.times(exitPerpPriceA).times(PERP_TAKER_FEE_RATE_FALLBACK));
      const realizedPnlA = computeRealizedPnl({
        entryLegNotional: spotQtyA.times(PRICE),
        exitLegNotional: spotQtyA.times(PRICE), // spot price unchanged in this fixture
        entryBasis: new Big(0), // perp == spot at A's own entry
        exitBasis: exitPerpPriceA.minus(new Big(PRICE)).div(PRICE),
        grossFundingCollected: new Big(0), // no settled funding row inserted for A
        totalFees: entryFeesA.plus(exitFeesA),
        realizedSlippage: new Big(0), // DEEP_BOOK_QTY keeps slippageBp exactly 0
      });
      // leverage=1 -> accrueBorrowCost's rate is algebraically exactly 0 (borrowCost.ts's own doc comment).
      const cashReturnedA = initialCapitalA.plus(realizedPnlA);
      const equityAtCloseA = cashOutsideAfterOpenA.plus(cashReturnedA);

      // Sanity: this fixture really does produce a "significant" loss (past
      // SIGNIFICANT_LOSS_THRESHOLD_PCT_OF_EQUITY), the branch of
      // computeNextPositionSizeFraction this test exercises end-to-end.
      expect(realizedPnlA.lt(0)).toBe(true);
      expect(realizedPnlA.div(equityAtCloseA).lt(SIGNIFICANT_LOSS_THRESHOLD_PCT_OF_EQUITY.times(-1))).toBe(true);

      const expectedSizeFractionForB = computeNextPositionSizeFraction([
        { realizedPnl: realizedPnlA, equityAtClose: equityAtCloseA },
      ]);
      expect(expectedSizeFractionForB.toString()).toBe("0.05"); // NO_HISTORY_FRACTION - STEP, floored at MIN_FRACTION (same value here)

      // --- THE CORE ASSERTION: symbol B's own persisted size must match what
      // pickBestCandidate/evaluateCandidate actually computed from THIS exact
      // fraction against THIS exact post-loss equity — not
      // NO_HISTORY_FRACTION (0.10) again, which is what a scenarioRunner.ts
      // regression silently dropping/mis-threading closedTradeHistory (wrong
      // sign at line ~1028, stale array, or never actually passed into
      // computeNextPositionSizeFraction) would produce instead.
      const expectedTargetNotionalB = equityAtCloseA.times(expectedSizeFractionForB);
      const expectedSizingB = sizePosition({
        targetNotional: expectedTargetNotionalB,
        markPrice: new Big(PRICE),
        perpQtyStep: DEFAULT_PERP_QTY_STEP,
      });
      if (!expectedSizingB.allowed) throw new Error("fixture bug: symbol B's own entry should be allowed");

      const perpQtyB = new Big(posB.perp_qty!);
      const spotQtyB = new Big(posB.spot_qty!);
      expect(perpQtyB.toString()).toBe(spotQtyB.toString());
      expect(perpQtyB.toString()).toBe(expectedSizingB.perpQty.toString());

      // Redundant-but-explicit: prove it is actually HALF of what the
      // (buggy, "history silently stayed empty") NO_HISTORY_FRACTION path
      // would have sized — the concrete, human-checkable number a wiring
      // regression would flip.
      const wronglySizedIfHistoryDropped = sizePosition({
        targetNotional: equityAtCloseA.times(NO_HISTORY_FRACTION),
        markPrice: new Big(PRICE),
        perpQtyStep: DEFAULT_PERP_QTY_STEP,
      });
      if (!wronglySizedIfHistoryDropped.allowed) throw new Error("fixture bug");
      expect(perpQtyB.toString()).not.toBe(wronglySizedIfHistoryDropped.perpQty.toString());
    },
  );
});
