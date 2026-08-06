import { z } from "zod";

// RR-05: testnet и mainnet используют разные переменные окружения,
// бот отказывается стартовать при несовпадении заявленного окружения с хостом.
const envSchema = z.object({
  APP_ENV: z.enum(["testnet", "mainnet"]),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Фаза 1 работает на публичных эндпоинтах — ключи не обязательны.
  // Когда появятся (Фаза 3+), они обязаны быть присвоены под правильный APP_ENV:
  // BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_API_SECRET для testnet,
  // BYBIT_MAINNET_API_KEY / BYBIT_MAINNET_API_SECRET для mainnet.
  BYBIT_TESTNET_API_KEY: z.string().optional(),
  BYBIT_TESTNET_API_SECRET: z.string().optional(),
  BYBIT_MAINNET_API_KEY: z.string().optional(),
  BYBIT_MAINNET_API_SECRET: z.string().optional(),
  // Опциональны: без них бот работает как раньше, просто не шлёт дайджест
  // (проверяется в collector.ts, не здесь — эта схема не решает, что обязательно).
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // RR-32: путь файлового флага kill switch. Опционален — killswitch-listener
  // подставляет свой дефолт, если не задано (см. его собственный комментарий).
  KILLSWITCH_FLAG_PATH: z.string().optional(),
  // RUNBOOK.md §4: внешний dead-man's-switch (healthchecks.io или аналог).
  // Опционален — без него collector.ts просто не заводит heartbeat, это не
  // ошибка (аккаунт у стороннего сервиса — шаг человека, не кода).
  HEALTHCHECK_PING_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * RR-02/RR-04: секреты читаются только из process.env, никогда не сериализуются целиком.
 * Отказ стартовать при невалидной схеме — не тихий дефолт (SRS §7 OPEN-параметры).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Намеренно НЕ логируем parsed.error целиком без фильтрации — он может
    // эхом содержать значения переменных окружения в сообщениях валидации.
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration, missing/invalid: ${missing}`);
  }

  const env = parsed.data;

  // RR-05: разные ключи для testnet/mainnet, отказ при несовпадении.
  if (env.APP_ENV === "testnet" && (env.BYBIT_MAINNET_API_KEY || env.BYBIT_MAINNET_API_SECRET)) {
    throw new Error(
      "APP_ENV=testnet but BYBIT_MAINNET_* is set — refusing to start (RR-05: prevents mainnet keys leaking into a testnet run)",
    );
  }
  if (env.APP_ENV === "mainnet" && (env.BYBIT_TESTNET_API_KEY || env.BYBIT_TESTNET_API_SECRET)) {
    throw new Error(
      "APP_ENV=mainnet but BYBIT_TESTNET_* is set — refusing to start (RR-05: prevents testnet keys leaking into a mainnet run)",
    );
  }

  cached = env;
  return env;
}

/** Только для тестов — сбрасывает кэш между кейсами. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
