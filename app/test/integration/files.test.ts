import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import {
  abandonFileRow,
  claimFileRow,
  commitFileRow,
  deleteFile,
  diskRelPath,
  hasAclGrant,
  initFilesStorage,
  renameFile,
  resolveById,
  resolveByNames,
  resolveByToken,
  resolveEffective,
  setFileProtection,
} from "../../src/storage/files.ts";
import { createCollection, setCollectionProtection } from "../../src/storage/collections.ts";
import type { Protection } from "../../src/lib/protection.ts";

// Against real MariaDB and a real temp directory. D-81/D-85: a file's identity is a surrogate id, and
// there is still no reconciliation - a row exists only because an upload claimed it, and a lookup queries
// the row and stats the one disk path it names.
describe("storage/files.ts - surrogate ids, two-phase commit (D-81/D-85)", () => {
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
    root = await mkdtemp(path.join(os.tmpdir(), "files-test-"));
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

  async function seedCollection(ownerSub = "user:owner"): Promise<string> {
    const collection = await createCollection({
      parentId: "",
      name: `c-${randomUUID()}`,
      ownerSub,
    });
    createdCollectionIds.push(collection.id);
    return collection.id;
  }

  // Claims, moves real bytes into place, and commits - the full D-85 lifecycle a real upload performs.
  async function seedCommittedFile(opts: {
    collectionId?: string;
    name?: string;
    protection?: Protection;
    ownerSub?: string | null;
    content?: string;
  }): Promise<{ id: string; diskDir: string; diskName: string; linkToken: string }> {
    const collectionId = opts.collectionId ?? (await seedCollection());
    const name = opts.name ?? `file-${randomUUID()}.txt`;
    const content = opts.content ?? "content";
    const diskDir = "2026/07";

    const claimed = await claimFileRow({
      collectionId,
      name,
      diskDir,
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub === undefined ? "user:owner" : (opts.ownerSub ?? "no-owner-placeholder"),
      uploaderSub: "user:owner",
      protection: opts.protection ?? "unlisted",
    });
    createdFileIds.push(claimed.id);

    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);

    await commitFileRow(claimed.id, {
      bytes: content.length,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
    });

    return { id: claimed.id, diskDir, diskName: claimed.diskName, linkToken: claimed.linkToken };
  }

  it("resolveByNames returns the record for a committed file present on disk", async () => {
    const collectionId = await seedCollection();
    const { id } = await seedCommittedFile({ collectionId, name: "photo.png", content: "abcd" });
    const collectionRow = (
      await getPool().query("SELECT name FROM collections WHERE id = ?", [collectionId])
    )[0] as { name: string }[];
    const collectionName = collectionRow[0]!.name;

    const record = await resolveByNames([collectionName, "photo.png"]);
    expect(record).toMatchObject({ id, name: "photo.png", bytes: 4, protection: "unlisted" });
    expect(record!.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);
  });

  it("resolveByNames returns null for a pending (uncommitted) row - D-85 exemption", async () => {
    const collectionId = await seedCollection();
    const claimed = await claimFileRow({
      collectionId,
      name: "still-uploading.txt",
      diskDir: "2026/07",
      diskName: `${randomUUID()}-still-uploading.txt`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "unlisted",
    });
    createdFileIds.push(claimed.id);

    const collectionRow = (
      await getPool().query("SELECT name FROM collections WHERE id = ?", [collectionId])
    )[0] as { name: string }[];
    expect(await resolveByNames([collectionRow[0]!.name, "still-uploading.txt"])).toBeNull();
    expect(await resolveById(claimed.id)).toBeNull();
  });

  it("resolveByNames returns null for a file whose collection segment does not exist", async () => {
    expect(await resolveByNames([`no-such-${randomUUID()}`, "x.txt"])).toBeNull();
  });

  it("resolveByNames cleans up and returns null when the row exists but the bytes are gone (D-16)", async () => {
    const { id, diskDir, diskName } = await seedCommittedFile({});
    await unlink(path.join(root, diskDir, diskName));
    expect(await resolveById(id)).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE id = ?", [id]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByToken resolves by token, and cleans up a dead one", async () => {
    const { id, linkToken, diskDir, diskName } = await seedCommittedFile({});
    expect((await resolveByToken(linkToken))?.id).toBe(id);

    await unlink(path.join(root, diskDir, diskName));
    expect(await resolveByToken(linkToken)).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE link_token = ?", [linkToken]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByToken returns null for an unknown token", async () => {
    expect(await resolveByToken("ZZZZZ")).toBeNull();
  });

  it("claimFileRow + commitFileRow records the uploader and captured media dimensions (D-74)", async () => {
    const collectionId = await seedCollection();
    const claimed = await claimFileRow({
      collectionId,
      name: "photo.png",
      diskDir: "2026/07",
      diskName: `${randomUUID()}-photo.png`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "unlisted",
    });
    createdFileIds.push(claimed.id);
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "hello");

    const committed = await commitFileRow(claimed.id, {
      bytes: 5,
      width: 640,
      height: 480,
      durationSeconds: 12.5,
      textPreview: null,
    });
    expect(committed.uploaderSub).toBe("user:owner");
    expect(committed.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);

    const record = await resolveById(claimed.id);
    expect(record?.width).toBe(640);
    expect(record?.height).toBe(480);
    expect(record?.durationSeconds).toBe(12.5);
  });

  it("abandonFileRow removes a pending row entirely (D-85 failure path)", async () => {
    const collectionId = await seedCollection();
    const claimed = await claimFileRow({
      collectionId,
      name: "will-fail.txt",
      diskDir: "2026/07",
      diskName: `${randomUUID()}-will-fail.txt`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "unlisted",
    });
    await abandonFileRow(claimed.id);
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE id = ?", [claimed.id]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("renameFile is a single UPDATE and moves no bytes - the old disk name still resolves the same file", async () => {
    const { id, diskDir, diskName } = await seedCommittedFile({ name: "before.txt", content: "same-bytes" });
    await renameFile(id, "after.txt");

    const record = await resolveById(id);
    expect(record?.name).toBe("after.txt");
    expect(record?.diskDir).toBe(diskDir);
    expect(record?.diskName).toBe(diskName); // the ORIGINAL disk name, pinned forever (D-82)
  });

  it("setFileProtection changes the level without touching anything else", async () => {
    const { id } = await seedCommittedFile({ protection: "unlisted" });
    await setFileProtection(id, "private");
    expect((await resolveById(id))?.protection).toBe("private");
  });

  describe("deleteFile (D-16 hard delete: row + acl + bytes)", () => {
    it("removes the row, acl rows, and the bytes on disk", async () => {
      const { id, diskDir, diskName } = await seedCommittedFile({});
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [id, "user:granted"]);

      await deleteFile(id);

      expect(await resolveById(id)).toBeNull();
      const [aclRows] = await getPool().query("SELECT COUNT(*) AS n FROM file_acl WHERE file_id = ?", [id]);
      expect((aclRows as { n: number }[])[0]?.n).toBe(0);
      const fs = await import("node:fs/promises");
      await expect(fs.stat(path.join(root, diskDir, diskName))).rejects.toThrow();
    });

    it("is idempotent - deleting an already-gone id does nothing and does not throw", async () => {
      await expect(deleteFile(`nonexistent${randomUUID()}`.replace(/-/g, "").slice(0, 16))).resolves.toBeUndefined();
    });
  });

  // D-96: the landmine. A row's stored `protection` is never safe to read directly - resolveEffective()
  // folds the collection's ancestor chain together with the file's own stored level via
  // lib/protection.ts's mostRestrictive(), and every read path must use ITS result, never record.protection.
  describe("resolveEffective (D-96 - effective protection)", () => {
    it("a public file in an unlisted collection is EFFECTIVELY unlisted, not public", async () => {
      const collectionId = await seedCollection();
      const { id } = await seedCommittedFile({ collectionId, protection: "public" });
      const record = await resolveById(id);
      const resolved = await resolveEffective(record!);
      expect(resolved.protection).toBe("public"); // the STORED value, untouched
      expect(resolved.effectiveProtection).toBe("unlisted"); // the collection is more restrictive
    });

    it("a public file in a public collection is effectively public", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `eff-public-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      createdCollectionIds.push(collection.id);
      const { id } = await seedCommittedFile({ collectionId: collection.id, protection: "public" });
      const resolved = await resolveEffective((await resolveById(id))!);
      expect(resolved.effectiveProtection).toBe("public");
    });

    it("raising the collection's protection is reflected immediately, with no rewrite of the file's own stored level", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `eff-raise-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "unlisted",
      });
      createdCollectionIds.push(collection.id);
      const { id } = await seedCommittedFile({ collectionId: collection.id, protection: "unlisted" });

      await setCollectionProtection(collection.id, "private");
      const raised = await resolveEffective((await resolveById(id))!);
      expect(raised.effectiveProtection).toBe("private");
      expect(raised.protection).toBe("unlisted"); // D-97: the file's own row is untouched

      // Lowering it again restores the previous per-file behaviour exactly.
      await setCollectionProtection(collection.id, "unlisted");
      const lowered = await resolveEffective((await resolveById(id))!);
      expect(lowered.effectiveProtection).toBe("unlisted");
    });

    it("the file's own level can be the most restrictive one in the chain", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `eff-file-strictest-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      createdCollectionIds.push(collection.id);
      const { id } = await seedCommittedFile({ collectionId: collection.id, protection: "private" });
      const resolved = await resolveEffective((await resolveById(id))!);
      expect(resolved.effectiveProtection).toBe("private");
    });
  });

  describe("hasAclGrant (security invariant 6 - byte-for-byte, never parsed)", () => {
    it("matches only the exact sub granted", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [id, grantedSub]);

      expect(await hasAclGrant(id, grantedSub)).toBe(true);
      expect(await hasAclGrant(id, grantedSub.slice(0, -1))).toBe(false);
      expect(await hasAclGrant(id, `${grantedSub}x`)).toBe(false);
    });

    it("returns false when no grant exists", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      expect(await hasAclGrant(id, `user:${randomUUID()}`)).toBe(false);
    });
  });

  // Review session 017 - acceptance criterion 11: "Two CONCURRENT same-named uploads into one collection
  // produce two distinct files." The suffixing used to happen in controllers/upload.ts, against a sibling
  // list read BEFORE the insert: two uploads in flight at once both read the same list, both picked the
  // same name, and the second one's INSERT died on uniq_name_in_collection. Resolving the collision inside
  // claimFileRow - at the insert that actually detects it - is what makes the criterion hold.
  describe("claimFileRow display-name collisions (AC11)", () => {
    it("suffixes a sequential same-name claim", async () => {
      const collectionId = await seedCollection();
      const first = await claim(collectionId, "dup.txt");
      const second = await claim(collectionId, "dup.txt");
      expect(first.name).toBe("dup.txt");
      expect(second.name).toBe("dup(2).txt");
    });

    it("resolves CONCURRENT same-name claims into two distinct rows", async () => {
      const collectionId = await seedCollection();
      const claimed = await Promise.all([
        claim(collectionId, "race.txt"),
        claim(collectionId, "race.txt"),
        claim(collectionId, "race.txt"),
      ]);

      const names = claimed.map((c) => c.name).sort();
      const ids = new Set(claimed.map((c) => c.id));
      expect(ids.size).toBe(3);
      expect(new Set(names).size).toBe(3); // no two rows share a display name
      expect(names).toContain("race.txt");
      // The suffix is never applied twice over ("race(2)(2).txt") - it is always recomputed from the
      // originally requested name.
      for (const name of names) expect(name).toMatch(/^race(\(\d+\))?\.txt$/);
    });

    async function claim(collectionId: string, name: string) {
      const claimed = await claimFileRow({
        collectionId,
        name,
        diskDir: "2026/07",
        diskName: `${randomUUID()}-${name}`,
        ownerSub: "user:owner",
        uploaderSub: "user:owner",
        protection: "unlisted",
      });
      createdFileIds.push(claimed.id);
      return claimed;
    }
  });
});
