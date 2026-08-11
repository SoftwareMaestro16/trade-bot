/**
 * Загрузка анонсов Bybit (листинги/делистинги) — публичный эндпоинт
 * /v5/announcements/index, без подписи. Голый fetch, как notify/telegram.ts: SDK
 * bybit-api этот маршрут не оборачивает, а нужен один GET и разбор списка.
 *
 * Назначение — ДАННЫЕ ДЛЯ ОПИСАНИЯ, не для решений: заголовки анонсов уходят в
 * LLM-контекст сводки рынка, чтобы владелец видел «скоро листят/делистят». В
 * торговый вето это НЕ идёт: авторитет по делистингу — структурное поле
 * deliveryTime из instruments-info, а не разбор новостей мелкой моделью
 * (перепутает символ/дату). Разделение сохраняет детерминизм риск-модуля.
 */

const ANNOUNCEMENTS_ENDPOINT = "https://api.bybit.com/v5/announcements/index";
const DEFAULT_TIMEOUT_MS = 10_000;
// type.key, которые нам интересны: новые листинги и делистинги. Остальное
// (обслуживание, активности) в контекст не тянем.
const RELEVANT_TYPE_KEYS = new Set(["new_crypto", "delistings"]);

export interface Announcement {
  title: string;
  /** type.key: "new_crypto" | "delistings" | ... */
  typeKey: string;
  url: string;
  publishTimeMs: number;
}

interface RawAnnouncement {
  title?: unknown;
  url?: unknown;
  publishTime?: unknown;
  dateTimestamp?: unknown;
  type?: { key?: unknown } | null;
}
interface RawResponse {
  result?: { list?: RawAnnouncement[] } | null;
}

/**
 * Оставляет только релевантные (листинги/делистинги) и свежие (в пределах
 * `withinDays`) анонсы, новейшие первыми. Чистая — тестируется без сети.
 */
export function filterRelevantAnnouncements(
  raw: readonly RawAnnouncement[],
  nowMs: number,
  withinDays = 14,
): Announcement[] {
  const cutoff = nowMs - withinDays * 24 * 60 * 60 * 1000;
  const out: Announcement[] = [];
  for (const a of raw) {
    const typeKey = typeof a.type?.key === "string" ? a.type.key : "";
    if (!RELEVANT_TYPE_KEYS.has(typeKey)) continue;
    if (typeof a.title !== "string" || a.title.trim().length === 0) continue;
    // publishTime — строка мс у Bybit; dateTimestamp — число мс. Берём что есть.
    const ms = Number(a.publishTime ?? a.dateTimestamp ?? 0);
    if (!Number.isFinite(ms) || ms <= 0 || ms < cutoff) continue;
    out.push({
      title: a.title.trim(),
      typeKey,
      url: typeof a.url === "string" ? a.url : "",
      publishTimeMs: ms,
    });
  }
  out.sort((x, y) => y.publishTimeMs - x.publishTimeMs);
  return out;
}

/**
 * Плоский текст-контекст для LLM: заголовки анонсов по категориям. Именно этот
 * текст модель переформулирует — фактические данные (заголовки Bybit) здесь, а
 * не в голове модели. Пустая строка, если анонсов нет.
 */
export function formatAnnouncementsContext(anns: readonly Announcement[]): string {
  if (anns.length === 0) return "";
  const listings = anns.filter((a) => a.typeKey === "new_crypto").slice(0, 8);
  const delistings = anns.filter((a) => a.typeKey === "delistings").slice(0, 8);
  const lines: string[] = ["Свежие анонсы Bybit (по данным биржи):"];
  if (delistings.length > 0) {
    lines.push("Делистинги:");
    for (const d of delistings) lines.push(`  - ${d.title}`);
  }
  if (listings.length > 0) {
    lines.push("Листинги:");
    for (const l of listings) lines.push(`  - ${l.title}`);
  }
  return lines.join("\n");
}

/**
 * GET анонсов. Никогда не бросает наружу сырую ошибку — при любой беде (сеть,
 * таймаут, битый ответ) возвращает пустой список: анонсы это НЕОБЯЗАТЕЛЬНЫЙ
 * контекст, их отсутствие не должно ломать сводку рынка.
 */
export async function fetchRecentAnnouncements(
  now: () => number = () => Date.now(),
  locale = "en-US",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Announcement[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${ANNOUNCEMENTS_ENDPOINT}?locale=${encodeURIComponent(locale)}&limit=50`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const body = (await response.json()) as RawResponse;
    const list = body.result?.list;
    if (!Array.isArray(list)) return [];
    return filterRelevantAnnouncements(list, now());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
