// E8 Wave B2: the volume half of the admin panel's Usage section. Node 24 (Dockerfile) ships fs.statfs,
// so no shelling out to `df` is needed.

import { statfs } from "node:fs/promises";

export type VolumeUsage = { totalBytes: number; freeBytes: number; usedBytes: number };

// D-35 / issues.md I-4: absolute free-space thresholds, not percentages - what matters is whether the box
// can still accept uploads, not what fraction of a shared, multi-app volume this app happens to occupy.
// These are the FIRST lines of code in the repo to read them - they have lived only in the decision log
// since 2026-07-19.
export const DISK_WARN_FREE_BYTES = 300 * 1024 ** 3;
export const DISK_CRITICAL_FREE_BYTES = 100 * 1024 ** 3;

// `bavail`, not `bfree`: they differ by the blocks reserved for the root user, and `bavail` is the honest
// answer to "can this box still accept an ordinary upload". Returns null (never throws) on any failure -
// logged at warn - because a container whose storage mount is missing is exactly when an admin most needs
// the REST of the panel to still render.
export async function volumeUsage(storageRoot: string): Promise<VolumeUsage | null> {
  try {
    const stats = await statfs(storageRoot);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch (err) {
    console.warn(`lib/diskUsage: statfs("${storageRoot}") failed`, err);
    return null;
  }
}
