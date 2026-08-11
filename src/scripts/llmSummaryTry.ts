import { pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import { createDb } from "../storage/db.js";
import { gatherMarketStats } from "../analysis/marketStats.js";
import { OpenRouterClient, DEFAULT_LLM_MODEL, FALLBACK_LLM_MODELS } from "../analysis/llm/index.js";
import { buildToolset } from "../analysis/llm/index.js";

/**
 * Разовая проверка КАЧЕСТВА резюме по каждой модели: гоняет market_assessment
 * на реальном срезе рынка через nvidia и через ling по отдельности и печатает,
 * что вернула каждая. Нужен, чтобы выбрать основную модель по факту (чистый
 * русский без «мыслей вслух»), а не наугад.
 *
 * Запуск: node --env-file=.env dist/scripts/llmSummaryTry.js
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.LLM_API_KEY) {
    console.log("LLM_API_KEY не задан.");
    return;
  }
  const db = createDb(env.DATABASE_URL);
  const stats = await gatherMarketStats(db);

  for (const model of [DEFAULT_LLM_MODEL, ...FALLBACK_LLM_MODELS]) {
    const toolset = buildToolset(new OpenRouterClient({ apiKey: env.LLM_API_KEY, model, requestTimeoutMs: 40_000 }));
    const started = Date.now();
    const result = await toolset.marketAssessment.run({ stats });
    const ms = Date.now() - started;
    console.log(`\n=== ${model} (${String(ms)} мс) ===`);
    console.log(result.narrative ?? `(нет резюме: ${result.llmError ?? "н/д"})`);
  }

  await db.destroy();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[llm-summary-try] fatal:", e);
    process.exit(1);
  });
}
