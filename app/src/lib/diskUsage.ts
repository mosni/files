// E8 Wave B2: the pure half of the admin panel's volume figures - the thresholds and the arithmetic.
//
// The statfs() call itself lives in storage/diskUsage.ts, not here: `lib` is I/O-free and `storage` is the
// only layer that touches the filesystem (technical-baseline.md §2). That split is not bookkeeping - this
// module is imported by web/src/pages/Admin.tsx for the thresholds, so while it held `import { statfs }
// from "node:fs/promises"` every `vite build` printed *Module "node:fs/promises" has been externalized for
// browser compatibility* and the SPA's dependency graph reached a Node builtin (review session 059).

export type VolumeUsage = { totalBytes: number; freeBytes: number; usedBytes: number };

// D-35 / issues.md I-4: absolute free-space thresholds, not percentages - what matters is whether the box
// can still accept uploads, not what fraction of a shared, multi-app volume this app happens to occupy.
// These are the FIRST lines of code in the repo to read them - they have lived only in the decision log
// since 2026-07-19.
export const DISK_WARN_FREE_BYTES = 300 * 1024 ** 3;
export const DISK_CRITICAL_FREE_BYTES = 100 * 1024 ** 3;

// The subset of Node's StatsFs this needs. Declared structurally so the arithmetic can be tested against
// values a real filesystem will not reproduce on demand - in particular bavail < bfree.
export type BlockCounts = { bsize: number; blocks: number; bavail: number };

// `bavail`, not `bfree`: they differ by the blocks reserved for the root user, and `bavail` is the honest
// answer to "can this box still accept an ordinary upload". `usedBytes` is therefore total-minus-available,
// which counts the reserved margin as used - deliberate, for the same reason.
export function volumeFromBlocks(stats: BlockCounts): VolumeUsage {
  const totalBytes = stats.bsize * stats.blocks;
  const freeBytes = stats.bsize * stats.bavail;
  return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
}
