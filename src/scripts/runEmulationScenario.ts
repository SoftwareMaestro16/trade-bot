import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Big from "big.js";
import { loadEnv } from "../config/env.js";
import { generateReports } from "../emulation/reportGenerator.js";
import { runScenario } from "../emulation/scenarioRunner.js";
import type { ScenarioConfig } from "../emulation/scenarioRunner.js";
import { createDb } from "../storage/db.js";
import { sendDocument, truncateCaption } from "../notify/telegram.js";
import { buildFallbackClient, buildToolset } from "../analysis/llm/index.js";
import { resolveReportCaption, buildCombinedReport } from "../emulation/reportDelivery.js";
import type { TradeReportInput } from "../analysis/llm/tools/tradeReportTool.js";

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

/**
 * One-off pipeline smoke test, 2026-08-10: the real PARAMS-CONSERVATIVE.md §4
 * turnover floors ($100M perp / $20M spot) intersected with real economics
 * (funding-rate premium ≥0.05%/8h) turned out empty across every emulation run
 * so far — not a bug, verified against live mainnet data (see
 * scripts/runEmulationScenario.ts's own doc comment above: the funding/economics
 * thresholds are untouched and real, some symbols DO clear them organically,
 * e.g. GRVTUSDT ~0.2%/8h — but every symbol clearing the funding bar during
 * this observed window had turnover well under $30M, and every symbol clearing
 * turnover had funding near-flat). Flipping this on relaxes ONLY the turnover
 * floor (risk/index.ts's RiskThresholds — the economics checks are NOT
 * touched) so at least a few real symbols can clear the whole veto chain and
 * exercise position-open/close/report/Telegram end-to-end. This is a pipeline
 * mechanics check, not a profitability read — buildLowCoverageCaveat-style
 * loud labeling below makes sure a run like this is never mistaken for one.
 * PARAMS-CONSERVATIVE.md's real production floors are untouched by this flag:
 * it only ever affects this ad-hoc script's own ScenarioConfig.
 */
const SMOKE_TEST_RELAXED_THRESHOLDS = true;
const SMOKE_TEST_MIN_PERP_TURNOVER_24H = new Big("10000000"); // $10M, vs $100M real floor
const SMOKE_TEST_MIN_SPOT_TURNOVER_24H = new Big("2000000"); // $2M, vs $20M real floor

// Below this many hours of observed data, the run is statistically close to
// meaningless (well under even one funding interval's worth of settlements
// for most symbols) — printed as a loud caveat, never silently omitted.
const MEANINGFUL_COVERAGE_HOURS = 7 * 24;

// Pulled out as pure, exported functions (rather than left inline in main())
// so the empty-table guard, the hours arithmetic, and the caveat-vs-silent
// branch can be unit tested without standing up a DB connection — see
// test/scripts/runEmulationScenario.test.ts.

/**
 * Resolves the observed tickers.fetched_at min/max into a concrete
 * {startAt, endAt} pair. kysely's min()/max() aggregate to `null` over zero
 * rows — an empty tickers table is a reachable runtime state (not one TS
 * itself rules out), so this throws loudly instead of ever silently falling
 * back to a synthetic range (e.g. `?? new Date()`), which would produce a
 * nonsensical near-zero window instead of a clear failure.
 */
export function resolveObservedRange(range: { minAt: Date | null; maxAt: Date | null }): {
  startAt: Date;
  endAt: Date;
} {
  if (range.minAt === null || range.maxAt === null) {
    throw new Error("[run-emulation] tickers table is empty — nothing to run a scenario against");
  }
  return { startAt: range.minAt, endAt: range.maxAt };
}

export function computeCoverageHours(startAt: Date, endAt: Date): number {
  return (endAt.getTime() - startAt.getTime()) / (60 * 60 * 1000);
}

export function buildLowCoverageCaveat(coverageHours: number, thresholdHours: number): string | null {
  if (coverageHours >= thresholdHours) {
    return null;
  }
  return (
    `[run-emulation] *** PRELIMINARY / LOW-CONFIDENCE RUN *** — only ${coverageHours.toFixed(1)}h of data ` +
    `(${thresholdHours.toFixed(0)}h considered a bare minimum for a meaningful read). ` +
    "Treat every number below as a pipeline smoke test, not a performance estimate."
  );
}

/**
 * Owner's ask (2026-08-09): the bot itself should hand over trade-level
 * detail via Telegram (which pair, why it opened/closed, what's left of the
 * deposit), not just a terminal log line only visible to whoever is watching
 * this script run — see main()'s TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID gate.
 * This is the caption text only; per-trade detail (symbol, entry/exit
 * reason, P&L) lives in the attached paper_trades_<run_id>.csv itself,
 * which is too granular to usefully summarize in a caption.
 */
export function buildTelegramCaption(
  runId: string,
  startingDeposit: Big,
  finalEquity: Big,
  positionsOpened: number,
  positionsClosed: number,
  coverageHours: number,
  lowCoverageCaveat: string | null,
): string {
  const netPnl = finalEquity.minus(startingDeposit);
  const netPnlPct = netPnl.div(startingDeposit).times(100);
  return (
    `📊 Эмуляция "${runId}"\n` +
    `Депозит: $${startingDeposit.toFixed(2)} -> $${finalEquity.toFixed(2)} ` +
    `(${netPnl.gte(0) ? "+" : ""}${netPnl.toFixed(2)} / ${netPnlPct.gte(0) ? "+" : ""}${netPnlPct.toFixed(2)}%)\n` +
    `Сделок: ${String(positionsOpened)} открыто / ${String(positionsClosed)} закрыто\n` +
    `Окно данных: ${coverageHours.toFixed(1)}ч` +
    (lowCoverageCaveat !== null ? " (PRELIMINARY — ниже 168ч минимума)" : "") +
    `\nПодробности по каждой сделке (пара, причина входа/выхода, P&L) — в приложенных файлах.`
  );
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  console.log("[run-emulation] determining observed data range and symbol universe...");

  const range = await db
    .selectFrom("tickers")
    .select((eb) => [eb.fn.min("fetched_at").as("minAt"), eb.fn.max("fetched_at").as("maxAt")])
    .executeTakeFirstOrThrow();
  const { startAt, endAt } = resolveObservedRange(range);
  const coverageHours = computeCoverageHours(startAt, endAt);

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
  const lowCoverageCaveat = buildLowCoverageCaveat(coverageHours, MEANINGFUL_COVERAGE_HOURS);
  if (lowCoverageCaveat !== null) {
    console.log(lowCoverageCaveat);
  }

  const config: ScenarioConfig = {
    name: SMOKE_TEST_RELAXED_THRESHOLDS ? `${SCENARIO_NAME}-relaxed-smoketest` : SCENARIO_NAME,
    leverage: LEVERAGE,
    startingDeposit: STARTING_DEPOSIT_USD,
    symbols,
    startAt,
    endAt,
    ...(SMOKE_TEST_RELAXED_THRESHOLDS
      ? {
          riskThresholds: {
            minPerpTurnover24h: SMOKE_TEST_MIN_PERP_TURNOVER_24H,
            minSpotTurnover24h: SMOKE_TEST_MIN_SPOT_TURNOVER_24H,
          },
        }
      : {}),
  };
  if (SMOKE_TEST_RELAXED_THRESHOLDS) {
    console.log(
      `[run-emulation] *** RELAXED-THRESHOLDS SMOKE TEST *** — turnover floors lowered to ` +
        `$${SMOKE_TEST_MIN_PERP_TURNOVER_24H.toString()} perp / $${SMOKE_TEST_MIN_SPOT_TURNOVER_24H.toString()} spot ` +
        `(real floors: $100M / $20M). Funding-rate economics thresholds are UNCHANGED. ` +
        "This run checks pipeline mechanics, not profitability — do not read these numbers as a strategy signal.",
    );
  }

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

  // Один файл вместо трёх (владелец): summary + trades + equity склеены в
  // paper_report_<runId>.md (CSV — секциями внутри). Пишем на диск и шлём его же.
  const combined = buildCombinedReport(runId, reports);
  await mkdir(REPORTS_DIR, { recursive: true });
  const combinedPath = path.join(REPORTS_DIR, combined.filename);
  await writeFile(combinedPath, combined.content, "utf8");
  console.log(`[run-emulation] wrote: ${combinedPath}`);

  // Подпись LLM-first (владелец): сначала резюме от LLM-инструмента разбора
  // отчёта; если LLM недоступен/сбоил — детерминированная подпись из тех же
  // чисел. reports.aggregates[0] всегда есть — один сценарий даёт один агрегат.
  const agg = reports.aggregates[0];
  const toolset =
    env.LLM_API_KEY && agg
      ? buildToolset(buildFallbackClient({ apiKey: env.LLM_API_KEY, ...(env.LLM_MODEL ? { primaryModel: env.LLM_MODEL } : {}) }))
      : null;

  // Optional — same "only wired up if both vars are set" gate collector.ts's
  // own digest/heartbeat use. Owner's ask: the bot itself hands over the
  // trade-level detail, not just a terminal log line.
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && agg) {
    const reportInput: TradeReportInput = {
      runId,
      startingDeposit: STARTING_DEPOSIT_USD,
      endingEquity: result.finalEquity,
      tradeCount: agg.tradeCount,
      winCount: agg.winCount,
      fundingIncome: agg.fundingUsd,
      basisPnl: agg.basisPnlUsd,
      fees: agg.feesUsd,
      slippage: agg.slippageUsd,
      borrowCost: agg.borrowCostUsd,
    };
    const { caption, source } = await resolveReportCaption(reportInput, toolset);
    const fullCaption = lowCoverageCaveat !== null ? `${caption}\n\n⚠️ ${lowCoverageCaveat}` : caption;
    const telegramConfig = { botToken: env.TELEGRAM_BOT_TOKEN, allowedChatId: env.TELEGRAM_CHAT_ID };
    await sendDocument(telegramConfig, combined.filename, combined.content, { caption: truncateCaption(fullCaption) });
    console.log(`[run-emulation] sent single report file to Telegram (caption source: ${source})`);
  } else {
    console.log("[run-emulation] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping Telegram delivery");
  }

  await db.destroy();
}

// Guarded so importing this module (e.g. test/scripts/runEmulationScenario.test.ts,
// to exercise resolveObservedRange/computeCoverageHours/buildLowCoverageCaveat
// in isolation) never triggers a real run — only a direct
// `node .../runEmulationScenario.js` invocation does.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[run-emulation] fatal:", e);
    process.exit(1);
  });
}
