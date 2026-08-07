import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";

/**
 * RR-32 (SRS.md, дословно): "Уровень 1 доступен двумя независимыми путями:
 * команда в Telegram и файл-флаг на диске." Этот модуль — файловая половина
 * того пути. Telegram-половина (RR-33, белый список chat_id) реализована
 * отдельно в notify/telegram.ts и намеренно не импортируется отсюда — два
 * пути обязаны оставаться независимыми на уровне кода, а не только на уровне
 * архитектурной диаграммы (AR-05, RISK-REGISTER.md FM-51: Telegram — сторонняя
 * зависимость в контуре безопасности, файл-флаг существует именно затем,
 * чтобы её не разделять).
 *
 * Содержимое файла нигде в этом модуле не читается и не имеет значения —
 * присутствие файла по данному пути само есть команда. То же самое
 * "простейшее, что не может сломаться посередине", что и в rateLimiter.ts:
 * нечего парсить — значит нечего распарсить неверно.
 *
 * Резолвинг абсолютного пути и его логирование при старте процесса — забота
 * вызывающего кода (collector.ts / будущий killswitch-listener), не этого
 * модуля. `flagFilePath` принимается уже resolved строкой; эта граница
 * проведена намеренно, чтобы функции ниже оставались тестируемыми на
 * произвольном временном пути и не зависели от process.cwd().
 */

/**
 * Синхронная проверка присутствия флага — намеренно, не `fs.promises.access`.
 * Это критический путь безопасности: и `startFileFlagWatcher`, и
 * `selfTestFileFlag` должны знать состояние диска прямо сейчас, без промиса,
 * которому неоткуда взять неожиданную отклонённость в момент, когда решается
 * "торговать дальше или нет". `fs.existsSync` не бросает исключений на
 * несуществующий путь — она для этого и существует.
 */
export function isFlagPresent(flagFilePath: string): boolean {
  return existsSync(flagFilePath);
}

export interface FileFlagWatcherOptions {
  flagFilePath: string;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Периодически (раз в `pollIntervalMs`, дефолт 2с) опрашивает `isFlagPresent`
 * и вызывает `onFlagDetected` ровно на переходе отсутствие -> наличие.
 *
 * Edge-triggered, а не level-triggered: без этого `onFlagDetected` (который
 * выше по цепочке взводит HALT) вызывался бы на каждом тике, пока владелец не
 * удалит файл вручную — сотни вызовов подряд на одно событие. Базовая линия
 * "было ли присутствие на прошлом тике" инициализируется реальным состоянием
 * диска на момент вызова этой функции, а не жёстко `false`: если флаг уже
 * лежит на диске в момент старта watcher'а (например, процесс перезапустился
 * при активном Уровне 1), это не "переход", который должен заметить именно
 * watcher, а уже существующее состояние — его обязан поймать прямой вызов
 * `isFlagPresent` при старте процесса, до того как этот watcher вообще
 * запущен, а не эта функция задним числом на первом тике.
 *
 * Если `onFlagDetected` бросает исключение, она логируется и проглатывается
 * здесь: это критический путь безопасности, и watcher не должен переставать
 * видеть флаг на будущих тиках только потому, что вышестоящий обработчик упал
 * на одном конкретном вызове.
 *
 * `onFlagDetected` типизирован как `() => void`, но TypeScript допускает
 * присвоение сюда `() => Promise<void>` (void-return assignability) без
 * ошибки компиляции. try/catch вокруг синхронного вызова ловит только
 * СИНХРОННЫЙ throw — если такой асинхронный колбэк отклонит промис уже
 * после первого await, это произойдёт вне try/catch и станет unhandled
 * promise rejection, который крашит именно тот процесс, чья единственная
 * задача — пережить и поймать сигнал останова (killswitch-listener). Ниже
 * поэтому дополнительно проверяется, не является ли результат вызова
 * thenable, и если да — навешивается обработчик отклонения ДО того, как
 * управление вернётся из этого тика (до какого-либо await), чтобы Node
 * успел увидеть обработчик и не считал промис unhandled.
 */
/**
 * `wasPresentAtStart` reports whether the flag was ALREADY on disk at the
 * instant this function's own baseline read happened. The caller must
 * decide what to do with that (apply a halt immediately) — this module only
 * establishes the fact, same division of responsibility as selfTestFileFlag.
 *
 * This is deliberately surfaced here instead of left to a separate caller-side
 * `isFlagPresent()` call made just before starting the watcher: two separate
 * reads leave a real (if narrow — two back-to-back synchronous syscalls, no
 * `await` between them) TOCTOU gap where a flag created in between is caught
 * by neither the caller's pre-check (already returned false) nor the watcher
 * (whose own baseline would read true, so it never sees a transition either)
 * — silently unnoticed for as long as the file sits there. One read, exposed
 * on the return value, structurally cannot race itself.
 */
export function startFileFlagWatcher(
  options: FileFlagWatcherOptions,
  onFlagDetected: () => void,
): { stop: () => void; wasPresentAtStart: boolean } {
  const { flagFilePath } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let wasPresent = isFlagPresent(flagFilePath);
  const wasPresentAtStart = wasPresent;

  const timer = setInterval(() => {
    const isPresent = isFlagPresent(flagFilePath);
    if (isPresent && !wasPresent) {
      try {
        const result: unknown = onFlagDetected();
        // Defensive runtime check for the case the type signature doesn't
        // prevent at compile time (see doc comment above): onFlagDetected
        // may actually be an async function whose returned promise rejects
        // after its first await, past the point this try/catch can see it.
        // Attached synchronously, in the same tick as the call above and
        // before any await here — a handler attached this early is what
        // keeps Node from ever considering the promise unhandled, no matter
        // when it later settles.
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          (result as PromiseLike<unknown>).then(undefined, (e: unknown) => {
            console.error(
              `[killswitch:fileFlag] onFlagDetected's returned promise rejected for ${flagFilePath} — watcher continues:`,
              e,
            );
          });
        }
      } catch (e) {
        console.error(`[killswitch:fileFlag] onFlagDetected threw for ${flagFilePath} — watcher continues:`, e);
      }
    }
    wasPresent = isPresent;
  }, pollIntervalMs);

  return {
    wasPresentAtStart,
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Startup self-test (SRS.md RR-32, RISK-REGISTER.md FM-34): создаёт флаг,
 * проверяет обнаружение, удаляет, проверяет прекращение. Вызывающий код
 * (collector.ts / будущий killswitch-listener) обязан отказаться начинать
 * торговлю, если это вернуло `false` — само решение "что делать при false"
 * сюда не входит, эта функция только устанавливает факт.
 *
 * Ни одна ошибка ФС не выходит наружу исключением. `false` покрывает и
 * "self-test логически не прошёл" (файл не появился/не исчез после
 * write/unlink), и "ФС отказала" (ENOENT на родительский каталог, EACCES и
 * т.п.) — для вызывающего кода оба случая требуют одного и того же ответа:
 * не торговать.
 */
export async function selfTestFileFlag(flagFilePath: string): Promise<boolean> {
  try {
    if (isFlagPresent(flagFilePath)) {
      console.warn(
        `[killswitch:fileFlag] self-test: ${flagFilePath} already exists before the self-test started — ` +
          "not touching a file that might belong to someone else (or be a leftover from a previous failed run); failing the self-test.",
      );
      return false;
    }

    await writeFile(flagFilePath, "");

    if (!isFlagPresent(flagFilePath)) {
      console.error(
        `[killswitch:fileFlag] self-test: wrote ${flagFilePath} but isFlagPresent reports false immediately after — write did not have the expected effect.`,
      );
      return false;
    }

    await unlink(flagFilePath);

    if (isFlagPresent(flagFilePath)) {
      console.error(
        `[killswitch:fileFlag] self-test: deleted ${flagFilePath} but isFlagPresent still reports true immediately after — delete did not have the expected effect.`,
      );
      return false;
    }

    return true;
  } catch (e) {
    console.error(`[killswitch:fileFlag] self-test threw for ${flagFilePath}:`, e);
    return false;
  }
}
