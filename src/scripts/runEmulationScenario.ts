import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Big from "big.js";
import { loadEnv } from "../config/env.js";
import { generateReports } from "../emulation/reportGenerator.js";
import { runScenario } from "../emulation/scenarioRunner.js";
import type { ScenarioConfig } from "../emulation/scenarioRunner.js";
import { createDb } from "../storage/db.js";

/**
 * One-off, manually-run driver — NOT part of collector.ts's regular schedule.
 * Runs a single paper-trading scenario over whatever real market data is
 * currently in the DB's tickers/funding_rates/etc. tables (Phase 1's own live
 * collection, or a restored copy of it), then renders the three
 * reportGenerator.ts artifacts to REPORTS_DIR.
 *
 * SCENARIO_NAME/LEVERAGE/STARTING_DEPOSIT_USD are top-of-file consts — same
 * convention as backfillFundingHistory.ts/fetchMarginTierData.ts (no CLI-arg
 * parsing precedent exists in this codebase, see src/scripts/ generally).
 * startAt/endAt are NOT hardcoded — they're derived from the actual observed
 * `tickers.fetched_at` range at run time, since a fixed date range would go
 * stale the moment more data accumulates.
 *
 * positionSizeUsd is deliberately left unset on the ScenarioConfig below so
 * `scenarioRunner.ts`'s own adaptive equity-fraction sizing
 * (`adaptivePositionSizing.ts`) actually runs, rather than being bypassed —
 * this is meant to exercise the real decision path, not a simplified one.
 *
 * Run once via: node --env-file=.env dist/scripts/runEmulationScenario.js
 * (after `npm run build`). Safe to re-run: each run creates a NEW
 * paper_scenarios row (scenarioRunner.ts never reuses one), so re-running
 * never mutates or deletes a prior run's results.
 */

const SCENARIO_NAME = "preliminary-real-data-run";
const LEVERAGE = new Big("1"); // 1.0 = fully self-funded, no borrowing (PARAMS-CONSERVATIVE.md's conservative posture, RISK-REGISTER.md FM-27 auto-borrow danger)
const STARTING_DEPOSIT_USD = new Big("1000");
const REPORTS_DIR = path.resolve(process.cwd(), "reports");

// Below this many hours of observed data, the run is statistically close to
// meaningless (well under even one funding interval's worth of settlements
// for most symbols) — printed as a loud caveat, never silently omitted.
const MEANINGFUL_COVERAGE_HOURS = 7 * 24;

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  console.log("[run-emulation] determining observed data range and symbol universe...");

  const range = await db
    .selectFrom("tickers")
    .select((eb) => [eb.fn.min("fetched_at").as("minAt"), eb.fn.max("fetched_at").as("maxAt")])
    .executeTakeFirstOrThrow();
  if (range.minAt === null || range.maxAt === null) {
    throw new Error("[run-emulation] tickers table is empty — nothing to run a scenario against");
  }
  const startAt = range.minAt;
  const endAt = range.maxAt;
  const coverageHours = (endAt.getTime() - startAt.getTime()) / (60 * 60 * 1000);

  // Re-derives the spot x perp intersection directly from what was actually
  // collected, rather than re-calling market-data/universe.ts's own
  // computeTradeableUniverse (which hits Bybit live) — this script only ever
  // reads what collector.ts already gathered under that same filter, so the
  // intersection here is a defensive re-check, not a new source of truth.
  const linearSymbols = await db
    .selectFrom("tickers")
    .select("symbol")
    .distinct()
    .where("category", "=", "linear")
    .execute();
  const spotSymbols = await db
    .selectFrom("tickers")
    .select("symbol")
    .distinct()
    .where("category", "=", "spot")
    .execute();
  const spotSet = new Set(spotSymbols.map((r) => r.symbol));
  const symbols = linearSymbols.map((r) => r.symbol).filter((s) => spotSet.has(s));
  symbols.sort();

  console.log(`[run-emulation] ${String(symbols.length)} symbols, ${startAt.toISOString()} -> ${endAt.toISOString()} (${coverageHours.toFixed(1)}h observed)`);
  if (coverageHours < MEANINGFUL_COVERAGE_HOURS) {
    console.log(
      `[run-emulation] *** PRELIMINARY / LOW-CONFIDENCE RUN *** — only ${coverageHours.toFixed(1)}h of data ` +
        `(${(MEANINGFUL_COVERAGE_HOURS).toFixed(0)}h considered a bare minimum for a meaningful read). ` +
        "Treat every number below as a pipeline smoke test, not a performance estimate.",
    );
  }

  const config: ScenarioConfig = {
    name: SCENARIO_NAME,
    leverage: LEVERAGE,
    startingDeposit: STARTING_DEPOSIT_USD,
    symbols,
    startAt,
    endAt,
  };

  console.log("[run-emulation] running scenario...");
  const result = await runScenario(db, config);
  console.log(
    `[run-emulation] done: ${String(result.ticksProcessed)} ticks, ` +
      `${String(result.positionsOpened)} opened / ${String(result.positionsClosed)} closed, ` +
      `finalEquity=$${result.finalEquity.toFixed(2)} (started $${STARTING_DEPOSIT_USD.toFixed(2)}, ` +
      `${result.finalEquity.minus(STARTING_DEPOSIT_USD).div(STARTING_DEPOSIT_USD).times(100).toFixed(2)}%)`,
  );

  const runId = `${SCENARIO_NAME}-${String(result.scenarioId)}`;
  const reports = await generateReports(db, runId, [result.scenarioId]);

  await mkdir(REPORTS_DIR, { recursive: true });
  const summaryPath = path.join(REPORTS_DIR, `paper_summary_${runId}.md`);
  const tradesPath = path.join(REPORTS_DIR, `paper_trades_${runId}.csv`);
  const equityPath = path.join(REPORTS_DIR, `paper_equity_curve_${runId}.csv`);
  await writeFile(summaryPath, reports.summaryMarkdown, "utf8");
  await writeFile(tradesPath, reports.tradesCsv, "utf8");
  await writeFile(equityPath, reports.equityCurveCsv, "utf8");
  console.log(`[run-emulation] wrote:\n  ${summaryPath}\n  ${tradesPath}\n  ${equityPath}`);

  await db.destroy();
}

main().catch((e) => {
  console.error("[run-emulation] fatal:", e);
  process.exit(1);
});
