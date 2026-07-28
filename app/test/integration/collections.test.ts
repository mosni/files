import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import {
  canUploadTo,
  collectionPath,
  createCollection,
  deleteCollectionRecursive,
  ensureDefaultCollection,
  listCollectionsFor,
  renameCollection,
  resolveCollectionByNames,
} from "../../src/storage/collections.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage, resolveById } from "../../src/storage/files.ts";

describe("storage/collections.ts - nested collections (D-80/D-88)", () => {
  let root: string;

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "collections-test-"));
    initFilesStorage(root);
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  }, 30_000);

  const createdCollectionIds: string[] = [];
  afterEach(async () => {
    while (createdCollectionIds.length > 0) {
      const id = createdCollectionIds.pop()!;
      await getPool().query("DELETE FROM collection_acl WHERE collection_id = ?", [id]);
      await getPool().query("DELETE FROM collections WHERE id = ?", [id]).catch(() => {});
    }
  });

  it("createCollection makes a root-level collection, resolvable by name", async () => {
    const name = `root-${randomUUID()}`;
    const collection = await createCollection({ parentId: "", name, ownerSub: "user:a" });
    createdCollectionIds.push(collection.id);

    expect(await resolveCollectionByNames([name])).toMatchObject({ id: collection.id, name, parentId: "" });
  });

  it("a collection may contain collections, arbitrarily nested, resolved segment by segment", async () => {
    const top = await createCollection({ parentId: "", name: `top-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(top.id);
    const mid = await createCollection({ parentId: top.id, name: "mid", ownerSub: "user:a" });
    createdCollectionIds.push(mid.id);
    const deep = await createCollection({ parentId: mid.id, name: "deep", ownerSub: "user:a" });
    createdCollectionIds.push(deep.id);

    const resolved = await resolveCollectionByNames([top.name, "mid", "deep"]);
    expect(resolved?.id).toBe(deep.id);
  });

  it("siblings cannot share a name (uniq_sibling_name)", async () => {
    const name = `dup-${randomUUID()}`;
    const first = await createCollection({ parentId: "", name, ownerSub: "user:a" });
    createdCollectionIds.push(first.id);
    await expect(createCollection({ parentId: "", name, ownerSub: "user:b" })).rejects.toThrow();
  });

  it("the same name IS allowed under different parents", async () => {
    const parentA = await createCollection({ parentId: "", name: `pa-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(parentA.id);
    const parentB = await createCollection({ parentId: "", name: `pb-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(parentB.id);

    const childA = await createCollection({ parentId: parentA.id, name: "shared", ownerSub: "user:a" });
    createdCollectionIds.push(childA.id);
    const childB = await createCollection({ parentId: parentB.id, name: "shared", ownerSub: "user:a" });
    createdCollectionIds.push(childB.id);
    expect(childA.id).not.toBe(childB.id);
  });

  it("collectionPath round-trips: root-first name segments down to the collection itself", async () => {
    const top = await createCollection({ parentId: "", name: `top-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(top.id);
    const mid = await createCollection({ parentId: top.id, name: "mid", ownerSub: "user:a" });
    createdCollectionIds.push(mid.id);
    const deep = await createCollection({ parentId: mid.id, name: "deep", ownerSub: "user:a" });
    createdCollectionIds.push(deep.id);

    expect(await collectionPath(deep.id)).toEqual([top.name, "mid", "deep"]);
    expect(await collectionPath(top.id)).toEqual([top.name]);
  });

  it("collectionPath throws rather than hangs if the depth bound is exceeded (cycle guard)", async () => {
    // Build a chain deeper than MAX_COLLECTION_DEPTH (32) to exercise the bound without an actual cycle.
    let parentId = "";
    let leafId = "";
    for (let i = 0; i < 34; i++) {
      const c = await createCollection({ parentId, name: `d${i}`, ownerSub: "user:a" });
      createdCollectionIds.push(c.id);
      parentId = c.id;
      leafId = c.id;
    }
    await expect(collectionPath(leafId)).rejects.toThrow(/max depth/);
  });

  it("ensureDefaultCollection is idempotent for the same sub", async () => {
    const name = `default-${randomUUID()}`;
    const first = await ensureDefaultCollection("user:a", name);
    createdCollectionIds.push(first.id);
    const second = await ensureDefaultCollection("user:a", name);
    expect(second.id).toBe(first.id);
  });

  it("ensureDefaultCollection gives two different owners distinct collections instead of sharing one (closes the pre-E3 comingling gap)", async () => {
    const name = `shared-name-${randomUUID()}`;
    const forA = await ensureDefaultCollection("user:a", name);
    createdCollectionIds.push(forA.id);
    const forB = await ensureDefaultCollection("user:b", name);
    createdCollectionIds.push(forB.id);

    expect(forA.id).not.toBe(forB.id);
    expect(forA.ownerSub).toBe("user:a");
    expect(forB.ownerSub).toBe("user:b");
    expect(forA.name).not.toBe(forB.name); // one of them got suffixed to stay globally unique at root
  });

  it("renameCollection is a single UPDATE", async () => {
    const collection = await createCollection({ parentId: "", name: `old-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(collection.id);
    await renameCollection(collection.id, "brand-new-name");
    expect(await resolveCollectionByNames(["brand-new-name"])).toMatchObject({ id: collection.id });
  });

  describe("canUploadTo", () => {
    it("the owner may always upload", async () => {
      const collection = await createCollection({ parentId: "", name: `u-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      expect(await canUploadTo(collection, { sub: "user:a" })).toBe(true);
    });

    it("a superuser may always upload", async () => {
      const collection = await createCollection({ parentId: "", name: `u-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      expect(await canUploadTo(collection, { sub: "user:root", mosni_owner: true })).toBe(true);
    });

    it("a stranger with no collection_acl row may not", async () => {
      const collection = await createCollection({ parentId: "", name: `u-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      expect(await canUploadTo(collection, { sub: "user:stranger" })).toBe(false);
    });

    it("D-87: a collection_acl grant with can_upload=1 is honoured even though E3 never writes one itself", async () => {
      const collection = await createCollection({ parentId: "", name: `u-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await getPool().query(
        "INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)",
        [collection.id, "user:granted"],
      );
      expect(await canUploadTo(collection, { sub: "user:granted" })).toBe(true);

      await getPool().query(
        "INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)",
        [collection.id, "user:denied"],
      );
      expect(await canUploadTo(collection, { sub: "user:denied" })).toBe(false);
    });
  });

  describe("deleteCollectionRecursive (D-88)", () => {
    it("deletes every descendant collection, file row and file's bytes", async () => {
      const top = await createCollection({ parentId: "", name: `del-${randomUUID()}`, ownerSub: "user:a" });
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:a" });
      const grandchild = await createCollection({ parentId: child.id, name: "grandchild", ownerSub: "user:a" });

      const claimed = await claimFileRow({
        collectionId: grandchild.id,
        name: "deep-file.txt",
        diskDir: "2026/07",
        diskName: `${randomUUID()}-deep-file.txt`,
        ownerSub: "user:a",
        uploaderSub: "user:a",
        protection: "unlisted",
      });
      const abs = path.join(root, ...diskRelPath(claimed).split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, "bytes");
      await commitFileRow(claimed.id, { bytes: 5, width: null, height: null, durationSeconds: null, textPreview: null });

      const { deletedFileIds } = await deleteCollectionRecursive(top.id);
      expect(deletedFileIds).toEqual([claimed.id]);

      expect(await resolveById(claimed.id)).toBeNull();
      const fs = await import("node:fs/promises");
      await expect(fs.stat(abs)).rejects.toThrow();

      for (const id of [top.id, child.id, grandchild.id]) {
        const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM collections WHERE id = ?", [id]);
        expect((rows as { n: number }[])[0]?.n).toBe(0);
      }
    });

    it("deleting a leaf collection with no files just removes it", async () => {
      const collection = await createCollection({ parentId: "", name: `leaf-${randomUUID()}`, ownerSub: "user:a" });
      const { deletedFileIds } = await deleteCollectionRecursive(collection.id);
      expect(deletedFileIds).toEqual([]);
      expect(await resolveCollectionByNames([collection.name])).toBeNull();
    });
  });

  it("listCollectionsFor returns only the given owner's collections", async () => {
    const mine = await createCollection({ parentId: "", name: `mine-${randomUUID()}`, ownerSub: "user:list-a" });
    createdCollectionIds.push(mine.id);
    const theirs = await createCollection({ parentId: "", name: `theirs-${randomUUID()}`, ownerSub: "user:list-b" });
    createdCollectionIds.push(theirs.id);

    const mineList = await listCollectionsFor("user:list-a");
    expect(mineList.map((c) => c.id)).toContain(mine.id);
    expect(mineList.map((c) => c.id)).not.toContain(theirs.id);
  });
});
