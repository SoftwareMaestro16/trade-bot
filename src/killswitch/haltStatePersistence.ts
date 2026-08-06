import type { ColumnType, Kysely } from "kysely";
import type { HaltState } from "./haltState.js";

/**
 * RISK-REGISTER.md FM-34 (дополняет RR-31..RR-38 SRS.md): "HALT персистится в БД
 * и файле, снимается только явной командой с записью кто/когда/почему." Этот
 * модуль — БД-половина персистентности поверх чистой модели `haltState.ts`
 * (которую он не изменяет, только сериализует/десериализует). Файловый флаг
 * (RR-32: второй независимый путь Уровня 1) — отдельная задача, здесь не
 * реализуется.
 *
 * Таблица `halt_state` (см. миграцию `create-halt-state-table`) — singleton:
 * ровно одна строка с id = 1, вставленная миграцией и никогда не удаляемая или
 * пересоздаваемая. `loadHaltState`/`saveHaltState` поэтому всегда адресуют её
 * напрямую по id — без ORDER BY/LIMIT и без INSERT в рантайме.
 */

// Singleton row id — совпадает с CHECK (id = 1) в миграции. Вынесен в константу,
// а не повторён как магическое число в обеих функциях ниже.
const HALT_STATE_ROW_ID = 1;

export interface HaltStateTable {
  id: number;
  halt_new: boolean;
  flatten_all: boolean;
  reason: string | null;
  set_by: string | null;
  set_at_ms: string | null; // bigint over the wire as string, как остальные bigint-колонки в проекте
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>;
}

export interface HaltStateDatabase {
  halt_state: HaltStateTable;
}

/**
 * Читает единственную строку `halt_state` и восстанавливает `HaltState`.
 *
 * `set_at_ms` в БД — bigint-как-строка (см. `HaltStateTable`); `HaltState.setAtMs`
 * — `number | null`. Это единственное место во всём `killswitch/`, где bigint
 * сознательно превращается в number: `set_at_ms` здесь — метка времени для
 * человекочитаемого лога/алерта ("halt set at ..."), а не денежная величина или
 * биржевой идентификатор, для которых ADR-003/NFR-02 запрещают именно `number`.
 * Конвертация выполняется, только когда значение не `null` — `Number(null)`
 * дал бы `0`, а не `null`, и стёр бы различие между "halt ни разу не
 * устанавливался" и "установлен в момент времени 0".
 *
 * Строка гарантированно существует (создана миграцией и никогда не удаляется),
 * поэтому отсутствие строки — не ожидаемый случай, а повод упасть громко
 * (`executeTakeFirstOrThrow`), а не молча вернуть `CLEARED_STATE` (SRS RR-50:
 * ни одного проглоченного исключения).
 */
export async function loadHaltState(db: Kysely<HaltStateDatabase>): Promise<HaltState> {
  const row = await db
    .selectFrom("halt_state")
    .select(["halt_new", "flatten_all", "reason", "set_by", "set_at_ms"])
    .where("id", "=", HALT_STATE_ROW_ID)
    .executeTakeFirstOrThrow();

  return {
    haltNew: row.halt_new,
    flattenAll: row.flatten_all,
    reason: row.reason,
    setBy: row.set_by,
    setAtMs: row.set_at_ms === null ? null : Number(row.set_at_ms),
  };
}

/**
 * Перезаписывает единственную строку `halt_state` значениями из `state` —
 * UPDATE, не INSERT (строка уже существует, создана миграцией). Все пять полей
 * (halt_new, flatten_all, reason, set_by, set_at_ms) обновляются одним запросом
 * атомарно, а не серией отдельных UPDATE.
 *
 * `set_at_ms`: обратная конвертация к `loadHaltState` (`number | null` ->
 * `string | null`), т.к. bigint-колонка ожидает строку, как и везде в проекте.
 * Потеря точности здесь невозможна: `setAtMs` — миллисекундная метка от
 * `Date.now()`, на много порядков меньше `Number.MAX_SAFE_INTEGER`.
 *
 * `updated_at` выставляется явно (`new Date()`), т.к. `DEFAULT now()` в
 * миграции срабатывает только на INSERT — Postgres не переисполняет
 * DEFAULT-выражение колонки при UPDATE (это не триггер).
 *
 * Без ретраев и без обёртывающей транзакции — это одна атомарная операция БД,
 * большего сегодняшний scope не требует.
 */
export async function saveHaltState(db: Kysely<HaltStateDatabase>, state: HaltState): Promise<void> {
  await db
    .updateTable("halt_state")
    .set({
      halt_new: state.haltNew,
      flatten_all: state.flattenAll,
      reason: state.reason,
      set_by: state.setBy,
      set_at_ms: state.setAtMs === null ? null : String(state.setAtMs),
      updated_at: new Date(),
    })
    .where("id", "=", HALT_STATE_ROW_ID)
    .execute();
}
