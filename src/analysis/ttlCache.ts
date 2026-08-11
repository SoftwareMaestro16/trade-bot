/**
 * Кэш одного значения с временем жизни. Нужен, чтобы каждый тап «📈 Рынок» не
 * дёргал БД заново: сбор среза рынка (analysis/marketStats.ts) — это три
 * запроса на ~300 символов, а рынок за 5 минут ощутимо не меняется.
 *
 * Одно значение, не Map по ключам: у оценки рынка нет ключа — это глобальный
 * «сейчас». Часы инъектируются для детерминированного теста TTL без реального
 * времени.
 */
export class TtlCache<T> {
  private entry: { value: T; expiresAt: number } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Свежее значение или null, если пусто/протухло. */
  get(): T | null {
    if (this.entry === null) return null;
    if (this.now() >= this.entry.expiresAt) {
      this.entry = null;
      return null;
    }
    return this.entry.value;
  }

  set(value: T): void {
    this.entry = { value, expiresAt: this.now() + this.ttlMs };
  }

  /** Явный сброс — например, после действия, меняющего наблюдаемое состояние. */
  invalidate(): void {
    this.entry = null;
  }

  /**
   * Вернуть кэш или посчитать, закэшировать и вернуть. Два параллельных вызова
   * на холодном кэше оба посчитают (гонок это не ломает — просто лишняя
   * работа); для оценки рынка это приемлемо и проще, чем разделять in-flight
   * промис.
   */
  async getOrCompute(compute: () => Promise<T>): Promise<T> {
    const cached = this.get();
    if (cached !== null) return cached;
    const value = await compute();
    this.set(value);
    return value;
  }
}
