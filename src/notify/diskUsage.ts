import fs from "node:fs";

/**
 * Quality/robustness check added 2026-08-07: PostgreSQL's data volume shares
 * the VPS's host filesystem (Docker's overlay storage driver — confirmed via
 * `df -h /` on the real host: the same "overlay" filesystem backs both the
 * container layer and the bind-mounted data volume), so a disk-full event on
 * the host root would stall every DB write this whole project makes, not
 * just an isolated Docker volume filling up on its own.
 *
 * Triggered by finding orderbook_levels at 7.68GB after ~1.5 days of
 * collection with no compression enabled and a 7-day chunk_time_interval —
 * migrations/1786109550746_orderbook-levels-compression.sql fixes the root
 * cause going forward, but the chunk that already exists (2026-08-06 ..
 * 2026-08-13) keeps growing uncompressed until it closes naturally on
 * 2026-08-13 (compressing an actively-written chunk risks degrading
 * collector.ts's real-time inserts — FR-109's "no gaps" requirement matters
 * more than disk space, so that's deliberately not attempted). This check is
 * the interim safety net for that window: no dedicated alert channel yet
 * (would need its own repeat-suppression state to avoid spamming every
 * cycle — out of scope today), but every /status check now surfaces it, so
 * the slow-motion risk doesn't go unnoticed between now and 2026-08-13.
 */
export interface DiskUsage {
  path: string;
  totalBytes: number;
  availableBytes: number;
  usedFraction: number; // 0..1
}

/**
 * Returns null (never throws) when the path can't be statted — e.g. this
 * codebase's own Windows dev environment, where fs.statfsSync behaves
 * differently or the path doesn't resolve the same way. A monitoring check
 * that can crash the /status reply it's part of would be strictly worse than
 * one that just omits itself when it can't answer.
 */
export function checkDiskUsage(path = "/"): DiskUsage | null {
  try {
    const stats = fs.statfsSync(path);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    if (totalBytes <= 0) return null;
    return { path, totalBytes, availableBytes, usedFraction: 1 - availableBytes / totalBytes };
  } catch {
    return null;
  }
}
