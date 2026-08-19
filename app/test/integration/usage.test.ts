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
import {
  trackedBytesByOwner,
  trackedBytesTopCollections,
  trackedBytesTopFiles,
  trackedBytesTotal,
} from "../../src/storage/usage.ts";

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

  async function seedCollection(ownerSub: string, name?: string): Promise<string> {
    const collection = await createCollection({ parentId: "", name: name ?? `c-${randomUUID()}`, ownerSub });
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
    name?: string;
  }): Promise<string> {
    const name = opts.name ?? `f-${randomUUID()}.bin`;
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

  // Review session 059 rewrote this test's ASSERTIONS, not its subject. It used to seed 10/40/1000-byte
  // collections and assert they were the global top two - which is only true while nothing bigger exists
  // anywhere in this shared MariaDB. It went red the moment the D-79 visual check (which seeds a 308 KB
  // fixture collection into the same database) ran before `npm run verify`, so the gate's result depended
  // on which of the two rituals a session happened to run first. The claims in the name are all still
  // asserted, just relative to this test's OWN rows: grouping and ordering among the three it seeded, and
  // LIMIT as a row count, which is what LIMIT actually promises.
  it("trackedBytesTopCollections groups by collection, orders by bytes DESC, and respects LIMIT", async () => {
    const owner = `user:${randomUUID()}`;
    const small = await seedCollection(owner);
    const medium = await seedCollection(owner);
    const large = await seedCollection(owner);
    await seedFile({ collectionId: small, ownerSub: owner, bytes: 10 });
    await seedFile({ collectionId: medium, ownerSub: owner, bytes: 20 });
    await seedFile({ collectionId: medium, ownerSub: owner, bytes: 20 });
    await seedFile({ collectionId: large, ownerSub: owner, bytes: 1000 });

    const all = await trackedBytesTopCollections(10_000);
    const at = (id: string) => all.findIndex((r) => r.collectionId === id);
    expect(all.find((r) => r.collectionId === large)).toMatchObject({ bytes: 1000, fileCount: 1 });
    expect(all.find((r) => r.collectionId === medium)).toMatchObject({ bytes: 40, fileCount: 2 });
    expect(all.find((r) => r.collectionId === small)).toMatchObject({ bytes: 10, fileCount: 1 });
    // ORDER BY bytes DESC, read off the positions of this test's own three rows.
    expect(at(large)).toBeLessThan(at(medium));
    expect(at(medium)).toBeLessThan(at(small));
    // The whole list is ordered, not just these three.
    expect([...all].sort((a, b) => b.bytes - a.bytes).map((r) => r.bytes)).toEqual(all.map((r) => r.bytes));
    // LIMIT is a row count and is asserted as one.
    expect(await trackedBytesTopCollections(1)).toHaveLength(1);
    expect((await trackedBytesTopCollections(3)).length).toBeLessThanOrEqual(3);
  });

  // Live-testing addition (2026-08-19, Hannah): "top files should exist similar to top collections".
  // Scoped to this test's OWN rows for the same reason the collections test above is - the database is
  // shared with every other integration file and with scripts/visual-check.mjs.
  it("trackedBytesTopFiles orders by bytes DESC, respects LIMIT, and excludes a pending row", async () => {
    const owner = `user:${randomUUID()}`;
    const collectionId = await seedCollection(owner);
    const bigName = `big-${randomUUID()}.bin`;
    const smallName = `small-${randomUUID()}.bin`;
    const pendingName = `pending-${randomUUID()}.bin`;
    await seedFile({ collectionId, ownerSub: owner, bytes: 5_000, name: bigName });
    await seedFile({ collectionId, ownerSub: owner, bytes: 100, name: smallName });
    await seedFile({ collectionId, ownerSub: owner, bytes: 9_999_999, name: pendingName, state: "pending" });

    const all = await trackedBytesTopFiles(10_000);
    const at = (name: string) => all.findIndex((r) => r.name === name);
    expect(at(bigName)).toBeGreaterThanOrEqual(0);
    expect(at(bigName)).toBeLessThan(at(smallName));
    expect(all.some((r) => r.name === pendingName)).toBe(false); // D-85: an upload in flight is not the app's
    expect([...all].sort((a, b) => b.bytes - a.bytes).map((r) => r.bytes)).toEqual(all.map((r) => r.bytes));
    expect(await trackedBytesTopFiles(1)).toHaveLength(1);
  });

  // The row carries what the caller needs to build the file's real share URL - its own protection and
  // token (controllers/admin.ts folds the ancestor chain in for the EFFECTIVE level, D-96).
  it("trackedBytesTopFiles returns the collection name, protection and link token per row", async () => {
    const owner = `user:${randomUUID()}`;
    const collectionName = `usage-top-${randomUUID()}`;
    const collectionId = await seedCollection(owner, collectionName);
    const name = `linked-${randomUUID()}.bin`;
    await seedFile({ collectionId, ownerSub: owner, bytes: 4_242, name });

    const row = (await trackedBytesTopFiles(10_000)).find((r) => r.name === name)!;
    expect(row.collectionId).toBe(collectionId);
    expect(row.collectionName).toBe(collectionName);
    expect(row.ownerSub).toBe(owner);
    expect(row.bytes).toBe(4_242);
    expect(row.protection).toBeTruthy();
    expect(row.linkToken).toBeTruthy();
  });

  // LEFT JOIN, not JOIN: a root-level file has collection_id = '' and no collections row (D-126). An
  // INNER JOIN would silently drop the largest file on the box if it happened to sit at the root.
  it("trackedBytesTopFiles includes a ROOT-level file, with a null collection name", async () => {
    const owner = `user:${randomUUID()}`;
    const name = `root-${randomUUID()}.bin`;
    await seedFile({ collectionId: "", ownerSub: owner, bytes: 7_777, name });

    const row = (await trackedBytesTopFiles(10_000)).find((r) => r.name === name);
    expect(row).toBeDefined();
    expect(row!.collectionName).toBeNull();
    expect(row!.collectionId).toBe("");
  });

  // The collections rows carry their own token for the same reason.
  it("trackedBytesTopCollections returns each collection's link token", async () => {
    const owner = `user:${randomUUID()}`;
    const collectionId = await seedCollection(owner);
    await seedFile({ collectionId, ownerSub: owner, bytes: 321 });

    const row = (await trackedBytesTopCollections(10_000)).find((r) => r.collectionId === collectionId)!;
    expect(row.linkToken).toBeTruthy();
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
