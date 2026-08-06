import pino from "pino";

/**
 * Shared root logger (RUNBOOK.md §8, ADR-005: pino migration — "точечное
 * улучшение", now done). Emits plain JSON lines on stdout, deliberately NOT
 * pino-pretty: this project's actual production destination is journald
 * (RUNBOOK.md §3's systemd units), which already collects stdout/stderr
 * verbatim with no app-level rotation needed. Pretty-printing is a terminal
 * concern for a human reading `journalctl` interactively, not something this
 * process should spend cycles doing at write time — `journalctl` itself (or
 * `| pino-pretty` piped in ad hoc) is the right place for that, not here.
 *
 * Level is read directly from `process.env.LOG_LEVEL` rather than routed
 * through config/env.ts's zod schema: it's an operational knob (how much to
 * log), not a startup-correctness concern the way DATABASE_URL/APP_ENV are —
 * an invalid/unset value should never stop the process from doing its actual
 * job the way loadEnv()'s own validation failures deliberately do.
 *
 * Callers must NOT log through this root logger directly. Every module that
 * wants to log should create its own child logger tagged with a `module`
 * field, e.g. `const logger = rootLogger.child({ module: "collector" })` —
 * that field replaces the manual `[prefix]` string every call site used to
 * prepend by hand (e.g. `console.log("[collector] ...")`,
 * `console.error("[killswitch-listener] ...")`), so don't keep both.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
});
