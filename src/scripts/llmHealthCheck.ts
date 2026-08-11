import { pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import { buildHealthTargets, checkLlmHealth, formatHealthReport } from "../analysis/llm/index.js";

/**
 * Разовая CLI-проверка доступности LLM — то же, что кнопка «🤖 LLM» в Telegram,
 * но из терминала. Пингует каждую модель (основную и резервную) и печатает, кто
 * жив. Способ проверить ключ на VPS, не тапая кнопку.
 *
 * Запуск: node --env-file=.env dist/scripts/llmHealthCheck.js
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.LLM_API_KEY) {
    console.log(formatHealthReport([]));
    return;
  }
  const targets = buildHealthTargets({
    apiKey: env.LLM_API_KEY,
    ...(env.LLM_MODEL ? { primaryModel: env.LLM_MODEL } : {}),
  });
  console.log(formatHealthReport(await checkLlmHealth(targets)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[llm-health] fatal:", e);
    process.exit(1);
  });
}
