// Against the REAL filesystem, not a mock - vi.mock("node:fs/promises", …) does not reliably intercept
// Node's builtin fs/promises statfs binding under this vitest/environment combination (confirmed: the
// mocked module was never consulted, the real syscall ran regardless of the registered factory). A real
// tmpdir plus a real statfs() call as the independent ground truth is both simpler and a more honest test
// of the arithmetic than a hand-rolled stub would be.
import { mkdtemp, rm, statfs as realStatfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { volumeUsage, DISK_WARN_FREE_BYTES, DISK_CRITICAL_FREE_BYTES } from "../../src/lib/diskUsage.ts";

describe("volumeUsage (E8 Wave B2)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "disk-usage-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("computes total/free/used from the real filesystem, using bavail rather than bfree", async () => {
    const ground = await realStatfs(dir);
    const usage = await volumeUsage(dir);
    expect(usage).toEqual({
      totalBytes: ground.bsize * ground.blocks,
      freeBytes: ground.bsize * ground.bavail,
      usedBytes: ground.bsize * ground.blocks - ground.bsize * ground.bavail,
    });
    // On a real filesystem bavail (blocks available to an unprivileged process) is <= bfree (blocks free
    // including the superuser-reserved margin) - if the implementation used bfree instead, this equality
    // would still hold on a filesystem with zero reserved blocks, so this only strengthens the check where
    // the environment actually has a reserved margin; the primary proof above already pins the exact value.
    expect(ground.bavail).toBeLessThanOrEqual(ground.bfree);
  });

  it("returns null (never throws) when statfs fails - the mount may be missing", async () => {
    await expect(volumeUsage(path.join(dir, "no-such-subdir"))).resolves.toBeNull();
  });

  it("exposes the documented D-35/I-4 threshold constants", () => {
    expect(DISK_WARN_FREE_BYTES).toBe(300 * 1024 ** 3);
    expect(DISK_CRITICAL_FREE_BYTES).toBe(100 * 1024 ** 3);
  });
});
