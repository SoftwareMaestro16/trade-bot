import type { Kysely } from "kysely";
import type { Database } from "../storage/schema.js";

/**
 * FR-109: пропуски сбора обнаруживаются и записываются, а не предполагаются.
 * Exit criterion Фазы 1 ("две недели без пропусков") измеряется по строкам этой
 * таблицы — continuity — это то, что можно посчитать SQL-запросом по
 * `collection_runs`, а не то, что "вроде бы работало".
 *
 * Записывает `running` до начала `fn`, затем `completed`/`failed` по результату.
 * Ошибка внутри `fn` не проглатывается (SRS RR-50) — она пробрасывается вызывающему
 * после того, как записана в `collection_runs.error`.
 */
export async function runCollectionCycle<T extends { symbolsCollected: number }>(
  db: Kysely<Database>,
  symbolsExpected: number,
  fn: () => Promise<T>,
): Promise<T> {
  const { id } = await db
    .insertInto("collection_runs")
    .values({ symbols_expected: symbolsExpected })
    .returning("id")
    .executeTakeFirstOrThrow();

  try {
    const result = await fn();
    await db
      .updateTable("collection_runs")
      .set({
        status: "completed",
        finished_at: new Date(),
        symbols_collected: result.symbolsCollected,
      })
      .where("id", "=", id)
      .execute();
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .updateTable("collection_runs")
      .set({ status: "failed", finished_at: new Date(), error: message })
      .where("id", "=", id)
      .execute();
    throw e;
  }
}
