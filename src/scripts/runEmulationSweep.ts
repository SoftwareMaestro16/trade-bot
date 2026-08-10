import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Big from "big.js";
import { loadEnv } from "../config/env.js";
import { generateReports } from "../emulation/reportGenerator.js";
import { runScenario } from "../emulation/scenarioRunner.js";
import type { ScenarioConfig } from "../emulation/scenarioRunner.js";
import { createDb } from "../storage/db.js";
import { sendDocument, sendAlert } from "../notify/telegram.js";
import { resolveObservedRange, computeCoverageHours } from "./runEmulationScenario.js";
import { notionalForCapital } from "../strategy/capitalAllocation.js";

/**
 * One-off, manually-run parameter sweep — NOT part of collector.ts's schedule,
 * and deliberately a SEPARATE script from runEmulationScenario.ts (which stays
 * a single-config one-off driver) rather than a flag on it.
 *
 * Why this exists (2026-08-10): run-4's relaxed-threshold smoke test lost
 * -0.22% over 7 trades, and the per-trade breakdown showed WHY in a way a
 * single further run cannot settle — fees took -$2.89 while funding earned
 * +$0.07, because every position exited after 0.07-3.98h (0-1 funding
 * settlements) while risk/economics.ts's checkEntryThreshold had credited it
 * `r8h * 9` of income (9 = PARAMS-CONSERVATIVE.md §5's 3-day payback window
 * over an 8h settlement basis). Two independent explanations fit that data:
 *
 *   (a) the UNIVERSE was wrong — the smoke test's relaxed turnover floor
 *       admitted thin symbols whose basis whipsaws past the 0.5% emergency
 *       exit within minutes, which the real $100M floor exists to exclude; or
 *   (b) the ENTRY HORIZON was wrong — crediting 9 settlements of income to a
 *       position that survives one is a mis-specified gate on ANY universe.
 *
 * Fitting parameters to 7 trades would be curve-fitting noise, so this sweeps
 * both axes instead and reports each cell, rather than searching for whichever
 * combination happens to print a positive number. Every config here makes the
 * entry gate the SAME or STRICTER than production (lower payback horizon =>
 * less credited income for identical cost); the turnover floors are the only
 * relaxed dimension, and each report is labelled with exactly how far it sits
 * from PARAMS-CONSERVATIVE.md's real floors.
 *
 * Run via: node --env-file=.env dist/scripts/runEmulationSweep.js
 * Safe to re-run and safe to kill: each config writes its own paper_scenarios
 * row (scenarioRunner.ts never reuses one) and sends its own report as soon as
 * it finishes, so a sweep interrupted midway still delivers every config that
 * completed rather than losing the batch.
 */

const STARTING_DEPOSIT_USD = new Big("1000");
const REPORTS_DIR = path.resolve(process.cwd(), "reports");

/** PARAMS-CONSERVATIVE.md §4's real production floors, for labelling deltas. */
const REAL_PERP_FLOOR = new Big("100000000");

const MINUTES_PER_SETTLEMENT = 480; // r8h basis, market-data/normalizeFunding.ts

/**
 * Stops STARTING a new config once the deadline passes — an already-running
 * config is never interrupted mid-flight (killing it would waste its hours and
 * produce no report). Override with SWEEP_DEADLINE_ISO. Default 2026-08-11
 * 12:00 UTC per the owner's "до 11 числа обеда".
 */
const DEADLINE_ISO = process.env.SWEEP_DEADLINE_ISO ?? "2026-08-11T12:00:00Z";

/**
 * Comma-separated config keys to skip, e.g. after extending SWEEP mid-flight:
 * the already-completed configs keep their reports and their paper_scenarios
 * rows, and a relaunch resumes at the first one that has not run yet instead of
 * spending an hour recomputing an answer already sitting in Telegram.
 */
const SKIP_KEYS = new Set(
  (process.env.SWEEP_SKIP_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0),
);

interface SweepConfig {
  key: string;
  /** Plain-language statement of what this cell tests, quoted into the report caption. */
  hypothesis: string;
  minPerpTurnover24h: Big;
  minSpotTurnover24h: Big;
  /** Payback horizon fed to checkEntryThreshold, in minutes. */
  paybackMinutes: Big;
  /**
   * Perp leg's own margin leverage. It does NOT scale position size by itself —
   * emulation/borrowCost.ts models it purely as a `borrowedFraction = 1 - 1/L`
   * financing cost on whatever notional is requested, so raising it ALONE only
   * adds cost (the FM-27 danger it exists to price).
   *
   * Leverage's real-world benefit shows up only when it is paired with the
   * larger `positionSizeUsd` that the same capital now affords — see
   * `leverageRung`, which derives that size via notionalForCapital instead of
   * letting the two drift apart.
   */
  leverage: Big;
  /** Fixed notional per leg; undefined = adaptivePositionSizing.ts decides. */
  positionSizeUsd?: Big;
  /** Single-coin NOTIONAL cap; undefined = risk/leverage.ts's real CONCENTRATION_MAX. */
  maxConcentration?: Big;
  /** Slots; undefined = 1, i.e. RR-22's production cap. */
  maxConcurrentPositions?: number;
  /** Predicted-funding haircut; undefined = economics.ts's measured default. */
  fundingRealizationFactor?: Big;
}

/**
 * run-4's own settings, reused verbatim by every config that is not
 * deliberately varying them — that is what makes each config a controlled A/B
 * against a result we already have on the table, rather than a fresh run with
 * nothing to compare to.
 */
const RUN4_PERP_FLOOR = new Big("10000000");
const RUN4_SPOT_FLOOR = new Big("2000000");
const RUN4_HORIZON = new Big(3 * 24 * 60); // 9 settlements

/**
 * The owner's 80/20 split on a $1000 deposit — the capital budget every rung of
 * the leverage ladder below holds CONSTANT so that leverage is the only thing
 * varying. Without pinning capital, a leverage comparison silently compares two
 * different position sizes and tells you nothing about leverage itself.
 */
const OWNER_WORKING_CAPITAL = new Big("800");

/**
 * One rung of the leverage ladder. `notionalForCapital` is imported from
 * strategy/capitalAllocation.ts rather than re-derived here so the sweep and
 * the allocation model can never disagree about what a capital budget buys.
 *
 * `concentrationHeadroom` lifts the single-coin cap just above the notional
 * this rung actually requests — the cap must not be the thing that vetoes the
 * rung under test, or the experiment measures the cap instead of the leverage.
 */
function leverageRung(leverage: string, concentrationCap: string): SweepConfig {
  const L = new Big(leverage);
  const notional = notionalForCapital(OWNER_WORKING_CAPITAL, L);
  const borrowedPct = new Big(1).minus(new Big(1).div(L)).times(100);
  return {
    key: `lev-${leverage}-capital-800`,
    hypothesis:
      `ЛЕСТНИЦА ПЛЕЧА, ступень ${leverage}x. Капитал зафиксирован на $800 (раскладка 80/20), ` +
      `плечо меняется — и именно поэтому оборот другой: $${notional.toFixed(0)} вместо $400 при плече 1.0. ` +
      `Занято ${borrowedPct.toFixed(0)}% позиции, значит начисляется стоимость займа. ` +
      "Вопрос ступени: перевешивает ли рост funding с большего оборота стоимость займа и возросший риск ликвидации?",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: RUN4_HORIZON,
    leverage: L,
    positionSizeUsd: notional,
    maxConcentration: new Big(concentrationCap),
  };
}

function parallelSlots(slots: number): SweepConfig {
  return {
    key: `parallel-${String(slots)}-slots`,
    hypothesis:
      `ПАРАЛЛЕЛЬНЫЕ ПОЗИЦИИ, ${String(slots)} слотов. Всё как в базовой конфигурации, но бот может держать ` +
      `${String(slots)} позиции одновременно вместо одной (RR-22 снят — это фазовый предохранитель, не архитектурный запрет). ` +
      "Смысл: с одним слотом бот простаивал ~91% времени. Но слоты умножают возможности только если несколько пар " +
      "проходят вето ОДНОВРЕМЕННО — если в логе счётчик parallel-capacity нулевой, слоты не дадут ничего.",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: RUN4_HORIZON,
    leverage: new Big("1"),
    maxConcurrentPositions: slots,
  };
}

const SWEEP: SweepConfig[] = [
  {
    key: "baseline-1slot-haircut",
    hypothesis:
      "КОНТРОЛЬ. Настройки run-4 (адаптивный размер, плечо 1, горизонт 9 периодов, 1 слот), но с новой скидкой " +
      "на прогноз funding (0.65 — измерено: приходит 65-84% от обещанного). Показывает, сколько сделок отсекает " +
      "одна только эта поправка, и служит опорой для сравнения со всеми конфигурациями ниже.",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: RUN4_HORIZON,
    leverage: new Big("1"),
  },
  parallelSlots(3),
  parallelSlots(5),
  {
    key: "owner-80-20-notional-400",
    hypothesis:
      "РАСКЛАДКА ВЛАДЕЛЬЦА 80/20. Депозит $1000: $800 в работе, $200 в подушке/стейке. $800 капитала при плече 1.0 покупают $400 оборота (двойной капитал: спот + маржа), поэтому позиция зафиксирована на $400, а лимит концентрации поднят с 25% до 40% — иначе каждый вход отбивался бы с CONCENTRATION_EXCEEDED. Всё остальное как в run-4, поэтому сравнение с ним прямое: видно, во сколько раз выросли комиссии относительно роста позиции ($125 -> $400).",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: RUN4_HORIZON,
    leverage: new Big("1"),
    positionSizeUsd: new Big("400"),
    maxConcentration: new Big("0.40"),
  },
  // Leverage ladder, capital pinned at $800. Ordered ascending so that if the
  // deadline truncates the tail, what survives is still a monotone series.
  leverageRung("1.5", "0.50"),
  leverageRung("2", "0.56"),
  leverageRung("3", "0.62"),
  {
    key: "horizon-1x8h",
    hypothesis:
      "Та же вселенная и размер, что в run-4, но вход считает доход за 1 расчётный период (8ч) вместо 9 — то есть требует funding >= 0.62%/8ч. Прямая проверка: убыток был из-за завышенного горизонта входа?",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: new Big(MINUTES_PER_SETTLEMENT),
    leverage: new Big("1"),
  },
  {
    key: "size-200-vs-run4",
    hypothesis:
      "РИСКОВЫЙ ПРОГОН №1 — размер. Всё как в run-4, но позиция зафиксирована на $200 вместо ~$125, которые выбрал адаптивный сайзер (потолок риск-модуля — 25% депозита = $250). Проверяем ожидание «прибыль и убыток растут пропорционально»: комиссии тоже вырастут ровно во столько же раз.",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: RUN4_HORIZON,
    leverage: new Big("1"),
    positionSizeUsd: new Big("200"),
  },
  {
    key: "leverage-1.5-borrowed",
    hypothesis:
      "РИСКОВЫЙ ПРОГОН №2 — плечо. Всё как в run-4, но перп-нога финансируется с плечом 1.5 (треть позиции занята). Размер НЕ растёт — модель начисляет только стоимость займа, поэтому это цена риска FM-27 в чистом виде, без компенсирующего дохода.",
    minPerpTurnover24h: RUN4_PERP_FLOOR,
    minSpotTurnover24h: RUN4_SPOT_FLOOR,
    paybackMinutes: RUN4_HORIZON,
    leverage: new Big("1.5"),
  },
  {
    key: "mid-universe-50M",
    hypothesis:
      "Тот же горизонт и размер, что в run-4, но вселенная вдвое ликвиднее ($50M/$10M). Проверка второй гипотезы: убыток был из-за тонких пар?",
    minPerpTurnover24h: new Big("50000000"),
    minSpotTurnover24h: new Big("10000000"),
    paybackMinutes: RUN4_HORIZON,
    leverage: new Big("1"),
  },
];

interface SweepOutcome {
  key: string;
  trades: number;
  netPnlUsd: Big;
  returnPct: Big;
}

export function buildSweepCaption(
  cfg: SweepConfig,
  runId: string,
  finalEquity: Big,
  opened: number,
  closed: number,
  coverageHours: number,
): string {
  const netPnl = finalEquity.minus(STARTING_DEPOSIT_USD);
  const netPnlPct = netPnl.div(STARTING_DEPOSIT_USD).times(100);
  const perpFloorPct = cfg.minPerpTurnover24h.div(REAL_PERP_FLOOR).times(100);
  const settlements = cfg.paybackMinutes.div(MINUTES_PER_SETTLEMENT);
  return (
    `🧪 Прогон "${cfg.key}"\n\n` +
    `${cfg.hypothesis}\n\n` +
    `Депозит: $${STARTING_DEPOSIT_USD.toFixed(2)} -> $${finalEquity.toFixed(2)} ` +
    `(${netPnl.gte(0) ? "+" : ""}${netPnl.toFixed(2)} / ${netPnlPct.gte(0) ? "+" : ""}${netPnlPct.toFixed(2)}%)\n` +
    `Сделок: ${String(opened)} открыто / ${String(closed)} закрыто\n` +
    `Окно данных: ${coverageHours.toFixed(1)}ч\n\n` +
    `Пороги оборота: $${cfg.minPerpTurnover24h.toFixed(0)} перп / $${cfg.minSpotTurnover24h.toFixed(0)} спот ` +
    `(${perpFloorPct.toFixed(0)}% от боевого порога PARAMS-CONSERVATIVE.md §4).\n` +
    `Горизонт окупаемости на входе: ${settlements.toFixed(0)} расчётных периодов.\n` +
    `Плечо перп-ноги: ${cfg.leverage.toFixed(2)}` +
    (cfg.leverage.gt(1) ? ` (занято ${new Big(1).minus(new Big(1).div(cfg.leverage)).times(100).toFixed(0)}% позиции)` : " (свои деньги)") +
    `\nРазмер позиции: ${cfg.positionSizeUsd ? `$${cfg.positionSizeUsd.toFixed(0)} фиксированный` : "адаптивный"}` +
    (cfg.maxConcentration
      ? `\nЛимит концентрации: ${cfg.maxConcentration.times(100).toFixed(0)}% (боевой — 25%, ТАБУ п.11)`
      : "") +
    `\nОдновременных позиций: ${String(cfg.maxConcurrentPositions ?? 1)}` +
    `\nСкидка на прогноз funding: ${(cfg.fundingRealizationFactor ?? new Big("0.65")).times(100).toFixed(0)}%` +
    `\n\n` +
    `⚠️ Это исследовательский прогон на 5 днях данных, НЕ подтверждение прибыльности. ` +
    `Пороги оборота ослаблены относительно боевых — на таких парах хуже исполнение.\n` +
    `Внутри run_id=${runId}`
  );
}

async function runOne(
  db: ReturnType<typeof createDb>,
  cfg: SweepConfig,
  symbols: string[],
  startAt: Date,
  endAt: Date,
  coverageHours: number,
  telegram: { botToken: string; allowedChatId: string } | undefined,
): Promise<SweepOutcome> {
  const name = `sweep-${cfg.key}`;
  const config: ScenarioConfig = {
    name,
    leverage: cfg.leverage,
    startingDeposit: STARTING_DEPOSIT_USD,
    symbols,
    startAt,
    endAt,
    riskThresholds: {
      minPerpTurnover24h: cfg.minPerpTurnover24h,
      minSpotTurnover24h: cfg.minSpotTurnover24h,
      ...(cfg.maxConcentration ? { maxConcentration: cfg.maxConcentration } : {}),
      ...(cfg.fundingRealizationFactor ? { fundingRealizationFactor: cfg.fundingRealizationFactor } : {}),
    },
    ...(cfg.maxConcurrentPositions ? { maxConcurrentPositions: cfg.maxConcurrentPositions } : {}),
    expectedPaybackMinutes: cfg.paybackMinutes,
    ...(cfg.positionSizeUsd ? { positionSizeUsd: cfg.positionSizeUsd } : {}),
  };

  console.log(`[sweep] === starting ${cfg.key} ===`);
  const result = await runScenario(db, config);
  const netPnl = result.finalEquity.minus(STARTING_DEPOSIT_USD);
  console.log(
    `[sweep] ${cfg.key}: ${String(result.ticksProcessed)} ticks, ` +
      `${String(result.positionsOpened)} opened / ${String(result.positionsClosed)} closed, ` +
      `finalEquity=$${result.finalEquity.toFixed(2)} (${netPnl.toFixed(2)})`,
  );

  const runId = `${name}-${String(result.scenarioId)}`;
  const reports = await generateReports(db, runId, [result.scenarioId]);

  await mkdir(REPORTS_DIR, { recursive: true });
  const summaryPath = path.join(REPORTS_DIR, `paper_summary_${runId}.md`);
  const tradesPath = path.join(REPORTS_DIR, `paper_trades_${runId}.csv`);
  const equityPath = path.join(REPORTS_DIR, `paper_equity_curve_${runId}.csv`);
  await writeFile(summaryPath, reports.summaryMarkdown, "utf8");
  await writeFile(tradesPath, reports.tradesCsv, "utf8");
  await writeFile(equityPath, reports.equityCurveCsv, "utf8");

  if (telegram) {
    // Delivery is isolated from the result on purpose. An hour of computation
    // is already complete and written to REPORTS_DIR by this point, so letting
    // a Telegram-side failure propagate would discard a finished experiment
    // over a transport problem — which is exactly what a 400 "caption is too
    // long" did to this sweep's first config on 2026-08-10. The files stay on
    // disk either way and can be re-sent by hand.
    try {
      const caption = buildSweepCaption(
        cfg,
        runId,
        result.finalEquity,
        result.positionsOpened,
        result.positionsClosed,
        coverageHours,
      );
      await sendDocument(telegram, `paper_summary_${runId}.md`, reports.summaryMarkdown, { caption });
      await sendDocument(telegram, `paper_trades_${runId}.csv`, reports.tradesCsv);
      await sendDocument(telegram, `paper_equity_curve_${runId}.csv`, reports.equityCurveCsv);
      console.log(`[sweep] ${cfg.key}: reports sent to Telegram`);
    } catch (e) {
      console.error(`[sweep] ${cfg.key}: report DELIVERY failed (result is safe, files in ${REPORTS_DIR}):`, e);
    }
  }

  return {
    key: cfg.key,
    trades: result.positionsClosed,
    netPnlUsd: netPnl,
    returnPct: netPnl.div(STARTING_DEPOSIT_USD).times(100),
  };
}

export function buildFinalComparison(outcomes: SweepOutcome[], skipped: string[]): string {
  const lines = outcomes.map(
    (o) =>
      `${o.key}: ${String(o.trades)} сделок, ` +
      `${o.netPnlUsd.gte(0) ? "+" : ""}$${o.netPnlUsd.toFixed(2)} ` +
      `(${o.returnPct.gte(0) ? "+" : ""}${o.returnPct.toFixed(2)}%)`,
  );
  const skippedNote =
    skipped.length > 0 ? `\n\nНе успели до дедлайна: ${skipped.join(", ")}` : "";
  return (
    `📊 Сводка по всем прогонам\n\n${lines.join("\n")}${skippedNote}\n\n` +
    `Напоминание: это 5 дней данных и единицы сделок на прогон — статистически ` +
    `этого мало для вывода о прибыльности. Цель сравнения — понять, ЧТО именно ` +
    `двигает результат (ликвидность пар или горизонт удержания на входе), а не ` +
    `выбрать самую зелёную строчку.`
  );
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const deadlineMs = new Date(DEADLINE_ISO).getTime();
  if (!Number.isFinite(deadlineMs)) {
    throw new Error(`[sweep] SWEEP_DEADLINE_ISO is not a valid date: ${DEADLINE_ISO}`);
  }

  const range = await db
    .selectFrom("tickers")
    .select((eb) => [eb.fn.min("fetched_at").as("minAt"), eb.fn.max("fetched_at").as("maxAt")])
    .executeTakeFirstOrThrow();
  const { startAt, endAt } = resolveObservedRange(range);
  const coverageHours = computeCoverageHours(startAt, endAt);

  const linearSymbols = await db
    .selectFrom("tickers").select("symbol").distinct().where("category", "=", "linear").execute();
  const spotSymbols = await db
    .selectFrom("tickers").select("symbol").distinct().where("category", "=", "spot").execute();
  const spotSet = new Set(spotSymbols.map((r) => r.symbol));
  const symbols = linearSymbols.map((r) => r.symbol).filter((s) => spotSet.has(s));
  symbols.sort();

  console.log(
    `[sweep] ${String(symbols.length)} symbols, ${startAt.toISOString()} -> ${endAt.toISOString()} ` +
      `(${coverageHours.toFixed(1)}h), deadline ${DEADLINE_ISO}`,
  );

  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? { botToken: env.TELEGRAM_BOT_TOKEN, allowedChatId: env.TELEGRAM_CHAT_ID }
      : undefined;

  const outcomes: SweepOutcome[] = [];
  const skipped: string[] = [];

  for (const cfg of SWEEP) {
    if (SKIP_KEYS.has(cfg.key)) {
      console.log(`[sweep] skipping ${cfg.key} (SWEEP_SKIP_KEYS)`);
      continue;
    }
    if (Date.now() >= deadlineMs) {
      console.log(`[sweep] deadline reached — skipping ${cfg.key}`);
      skipped.push(cfg.key);
      continue;
    }
    try {
      outcomes.push(await runOne(db, cfg, symbols, startAt, endAt, coverageHours, telegram));
    } catch (e) {
      // One config failing must not lose the configs already completed, nor
      // block the ones after it — each is an independent experiment.
      console.error(`[sweep] ${cfg.key} FAILED:`, e);
      skipped.push(`${cfg.key} (ошибка)`);
    }
  }

  if (telegram && outcomes.length > 0) {
    await sendAlert(telegram, buildFinalComparison(outcomes, skipped));
  }
  console.log("[sweep] done");
  await db.destroy();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[sweep] fatal:", e);
    process.exit(1);
  });
}
