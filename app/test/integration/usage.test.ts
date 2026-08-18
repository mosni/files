// E8 Wave B1/B3. Deliberately placed in app/test/integration/, NOT app/test/unit/ as the hand-off's file
// list names it: storage/usage.ts queries the real files/collections tables, and app/test/unit/ runs
// service-free (docker-compose.verify.yml's verify-unit has no mariadb dependency) - the same
// misplacement redis.test.ts originally had, per verification-concept.md's "Fast inner loop" note ("if a
// 'unit' test reaches for a real service, move it").
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { trackedBytesByOwner, trackedBytesTopCollections, trackedBytesTotal } from "../../src/storage/usage.ts";

describe("storage/usage.ts (E8 Wave B1)", () => {
  let root: string;
  const createdFileIds: string[] = [];
  const createdCollectionIds: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "usage-test-"));
    initFilesStorage(root);
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  }, 30_000);

  afterEach(async () => {
    while (createdFileIds.length > 0) {
      const id = createdFileIds.pop()!;
      await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [id]);
      await getPool().query("DELETE FROM files WHERE id = ?", [id]);
    }
    while (createdCollectionIds.length > 0) {
      await getPool().query("DELETE FROM collections WHERE id = ?", [createdCollectionIds.pop()]);
    }
  });

  async function seedCollection(ownerSub: string): Promise<string> {
    const collection = await createCollection({ parentId: "", name: `c-${randomUUID()}`, ownerSub });
    createdCollectionIds.push(collection.id);
    return collection.id;
  }

  // `bytes` is written directly via commitFileRow, independent of real on-disk content size - the same
  // shape files.test.ts's seedCommittedFile uses, extended with an explicit `bytes`/`state` so a single
  // test can fabricate a total above 2^32 without writing gigabytes of real content.
  async function seedFile(opts: {
    collectionId: string;
    ownerSub: string | null;
    bytes: number;
    state?: "pending" | "committed";
  }): Promise<string> {
    const name = `f-${randomUUID()}.bin`;
    const diskDir = "2026/08";
    const claimed = await claimFileRow({
      collectionId: opts.collectionId,
      name,
      diskDir,
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub ?? "no-owner-placeholder",
      uploaderSub: "user:uploader",
      protection: "private",
      uploaderName: null,
    });
    createdFileIds.push(claimed.id);
    if ((opts.state ?? "committed") === "pending") return claimed.id;

    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "x");
    await commitFileRow(claimed.id, {
      bytes: opts.bytes,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
      thumbName: null,
      isText: false,
    });
    return claimed.id;
  }

  it("trackedBytesTotal sums bytes and counts only committed files", async () => {
    const collectionId = await seedCollection("user:owner");
    const totalBefore = await trackedBytesTotal();

    await seedFile({ collectionId, ownerSub: "user:owner", bytes: 100 });
    await seedFile({ collectionId, ownerSub: "user:owner", bytes: 250 });
    await seedFile({ collectionId, ownerSub: "user:owner", bytes: 50 });
    // A pending row (D-85) is an upload in flight - its bytes are not yet the app's and must not count.
    await seedFile({ collectionId, ownerSub: "user:owner", bytes: 999_999, state: "pending" });

    const totalAfter = await trackedBytesTotal();

    expect(totalAfter.bytes - totalBefore.bytes).toBe(400);
    expect(totalAfter.fileCount - totalBefore.fileCount).toBe(3);
  });

  it("trackedBytesByOwner groups by owner_sub across two owners, excludes a pending row", async () => {
    const ownerA = `user:${randomUUID()}`;
    const ownerB = `user:${randomUUID()}`;
    const collectionId = await seedCollection(ownerA);
    await seedFile({ collectionId, ownerSub: ownerA, bytes: 100 });
    await seedFile({ collectionId, ownerSub: ownerA, bytes: 200 });
    await seedFile({ collectionId, ownerSub: ownerB, bytes: 300 });
    await seedFile({ collectionId, ownerSub: ownerB, bytes: 999_999, state: "pending" });

    const byOwner = await trackedBytesByOwner();
    expect(byOwner.find((r) => r.ownerSub === ownerA)).toEqual({ ownerSub: ownerA, bytes: 300, fileCount: 2 });
    expect(byOwner.find((r) => r.ownerSub === ownerB)).toEqual({ ownerSub: ownerB, bytes: 300, fileCount: 1 });
  });

  it("trackedBytesTopCollections groups by collection across three collections, respects LIMIT, orders by bytes DESC", async () => {
    const owner = `user:${randomUUID()}`;
    const small = await seedCollection(owner);
    const medium = await seedCollection(owner);
    const large = await seedCollection(owner);
    await seedFile({ collectionId: small, ownerSub: owner, bytes: 10 });
    await seedFile({ collectionId: medium, ownerSub: owner, bytes: 20 });
    await seedFile({ collectionId: medium, ownerSub: owner, bytes: 20 });
    await seedFile({ collectionId: large, ownerSub: owner, bytes: 1000 });

    const top = await trackedBytesTopCollections(2);
    expect(top).toHaveLength(2);
    expect(top[0]).toMatchObject({ collectionId: large, bytes: 1000, fileCount: 1 });
    expect(top[1]).toMatchObject({ collectionId: medium, bytes: 40, fileCount: 2 });
    expect(top.some((r) => r.collectionId === small)).toBe(false); // LIMIT 2 excludes the smallest
  });

  // mysql2 returns SUM() over BIGINT UNSIGNED as a string or BigInt once past 32-bit magnitude - this
  // proves the mapping to a real JS number, not merely a value that happens to look numeric.
  it("a byte total above 2^32 maps to a correct JavaScript number", async () => {
    const owner = `user:${randomUUID()}`;
    const collectionId = await seedCollection(owner);
    const big = 2 ** 32 + 12_345;
    await seedFile({ collectionId, ownerSub: owner, bytes: big });

    const byOwner = await trackedBytesByOwner();
    const row = byOwner.find((r) => r.ownerSub === owner);
    expect(row?.bytes).toBe(big);
    expect(typeof row?.bytes).toBe("number");
  });
});
