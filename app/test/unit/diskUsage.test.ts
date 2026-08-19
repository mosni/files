// E8 Wave B2, revised by review session 059.
//
// The arithmetic is tested against SYNTHETIC block counts, because that is the only way the "bavail, not
// bfree" claim can be made to fail. The original test compared volumeUsage() against a real statfs() of a
// tmpdir and said so in its own comment: on a filesystem with no reserved margin bavail === bfree, so a
// `bfree` implementation passed it identically. Splitting the pure arithmetic out of the syscall
// (lib/diskUsage.ts) is what makes bavail < bfree constructible - and constructible is the whole point.
import { mkdtemp, rm, statfs as realStatfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { volumeFromBlocks, DISK_WARN_FREE_BYTES, DISK_CRITICAL_FREE_BYTES } from "../../src/lib/diskUsage.ts";
import { volumeUsage } from "../../src/storage/diskUsage.ts";

describe("volumeFromBlocks (lib/diskUsage.ts, E8 Wave B2)", () => {
  it("uses bavail, NOT bfree - a filesystem with a reserved root margin reports the smaller figure", () => {
    // 4 KiB blocks, 1000 blocks total, 200 free but only 150 available to an unprivileged process.
    const usage = volumeFromBlocks({ bsize: 4096, blocks: 1000, bavail: 150, bfree: 200 } as never);
    expect(usage.freeBytes).toBe(150 * 4096); // 614400 - bfree would give 819200 and fail here
    expect(usage.totalBytes).toBe(1000 * 4096);
    // usedBytes counts the reserved margin as used, which is the same honesty as picking bavail.
    expect(usage.usedBytes).toBe(1000 * 4096 - 150 * 4096);
  });

  it("total = free + used, for any block counts", () => {
    const usage = volumeFromBlocks({ bsize: 512, blocks: 123_456, bavail: 7_890 });
    expect(usage.freeBytes + usage.usedBytes).toBe(usage.totalBytes);
  });
});

describe("volumeUsage (storage/diskUsage.ts, E8 Wave B2)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "disk-usage-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the real filesystem's figures, wired through volumeFromBlocks", async () => {
    const ground = await realStatfs(dir);
    expect(await volumeUsage(dir)).toEqual(volumeFromBlocks(ground));
  });

  it("returns null (never throws) when statfs fails - the mount may be missing", async () => {
    await expect(volumeUsage(path.join(dir, "no-such-subdir"))).resolves.toBeNull();
  });
});

describe("the D-35/I-4 threshold constants", () => {
  it("carry the documented values", () => {
    expect(DISK_WARN_FREE_BYTES).toBe(300 * 1024 ** 3);
    expect(DISK_CRITICAL_FREE_BYTES).toBe(100 * 1024 ** 3);
  });
});
