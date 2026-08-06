// Loads .env into process.env for tests that need a real local dependency
// (e.g. test/storage/db.test.ts against the docker-compose Postgres).
// Node 22 has this built in — no dotenv package needed.
try {
  process.loadEnvFile();
} catch {
  // No .env present (e.g. CI without local secrets) — tests that need it will
  // fail with a clear connection error instead of silently using stale config.
}
