import { pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import { createDb } from "../storage/db.js";
import { gatherMarketStats } from "../analysis/marketStats.js";
import { assessMarket } from "../analysis/marketAssessment.js";
import { formatAssessmentFacts } from "../analysis/llm/tools/marketAssessmentTool.js";
import { computeOutlook, formatOutlookFacts } from "../analysis/llm/tools/opportunityOutlookTool.js";

/**
 * Разовый CLI-скан рынка: собирает срез (gatherMarketStats), считает оценку
 * пригодности и перспективу, печатает. Это же — переиспользуемая основа для
 * Telegram-кнопки «Рынок» и периодического сканера, и первый способ проверить
 * marketStats.ts против живой БД (сырой SQL там мог содержать ошибку).
 *
 * Запуск: node --env-file=.env dist/scripts/marketScan.js
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const stats = await gatherMarketStats(db);
  const assessment = assessMarket(stats);
  const outlook = computeOutlook(assessment);

  console.log("=== ОЦЕНКА РЫНКА ===");
  console.log(formatAssessmentFacts(assessment));
  console.log("\n=== ПЕРСПЕКТИВА ===");
  console.log(formatOutlookFacts(outlook));
  console.log(
    `\n[market-scan] score=${String(assessment.suitabilityScore)} suitability=${assessment.suitability} ` +
      `symbols=${String(stats.length)} opportunities=${String(assessment.opportunities.length)}`,
  );

  await db.destroy();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[market-scan] fatal:", e);
    process.exit(1);
  });
}
