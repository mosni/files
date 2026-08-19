// E8 Wave B2: the volume half of the admin panel's Usage section. Node 24 (Dockerfile) ships fs.statfs, so
// no shelling out to `df` is needed. Lives in storage/ because it touches the filesystem; the thresholds
// and the arithmetic are pure and live in lib/diskUsage.ts, which `web` imports (technical-baseline.md §2).

import { statfs } from "node:fs/promises";
import { volumeFromBlocks, type VolumeUsage } from "../lib/diskUsage.ts";

// Returns null (never throws) on any failure - logged at warn - because a container whose storage mount is
// missing is exactly when an admin most needs the REST of the panel to still render.
export async function volumeUsage(storageRoot: string): Promise<VolumeUsage | null> {
  try {
    return volumeFromBlocks(await statfs(storageRoot));
  } catch (err) {
    console.warn(`storage/diskUsage: statfs("${storageRoot}") failed`, err);
    return null;
  }
}
