/**
 * ARCHITECTURE.md §2: `risk/` has veto power over every `strategy/` decision.
 * Every check function in `risk/` returns this shape — a shared contract so the
 * aggregator (not yet written) can compose independent checks uniformly, and so
 * FR-307/SRS ("все срабатывания вето risk/ с причинами") has a machine-readable
 * reason on every denial, not just a boolean.
 */
export type VetoResult =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

export function allow(): VetoResult {
  return { allowed: true };
}

export function deny(code: string, reason: string): VetoResult {
  return { allowed: false, code, reason };
}
