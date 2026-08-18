import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import {
  canUploadTo,
  collectionBreadcrumb,
  collectionPath,
  countDescendants,
  createCollection,
  deleteCollectionRecursive,
  grantCollectionAcl,
  hasAclGrantOnChain,
  hasAnyUploadGrant,
  hasCollectionAclGrant,
  isDescendantOf,
  listCollectionGrants,
  listCollectionsFor,
  listLinkAuthorizedChildCollections,
  listVisibleChildCollections,
  moveCollection,
  revokeCollectionAcl,
  protectionChain,
  renameCollection,
  resolveCollectionById,
  resolveCollectionByNames,
  resolveCollectionByToken,
  resolveCollectionEffective,
  setCollectionProtection,
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

  it("createCollection defaults to unlisted protection with a well-shaped, unique link_token (D-95/D-98/D-105)", async () => {
    const collection = await createCollection({ parentId: "", name: `prot-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(collection.id);
    expect(collection.protection).toBe("unlisted");
    expect(collection.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);
  });

  it("createCollection accepts an explicit protection (D-105: the caller resolves the parent's level)", async () => {
    const collection = await createCollection({
      parentId: "",
      name: `prot-explicit-${randomUUID()}`,
      ownerSub: "user:a",
      protection: "private",
    });
    createdCollectionIds.push(collection.id);
    expect(collection.protection).toBe("private");
  });

  it("setCollectionProtection changes only protection, leaving default_protection untouched", async () => {
    const collection = await createCollection({ parentId: "", name: `setprot-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(collection.id);
    await setCollectionProtection(collection.id, "secret");
    const updated = await resolveCollectionById(collection.id);
    expect(updated?.protection).toBe("secret");
    expect(updated?.defaultProtection).toBe("unlisted");
  });

  describe("protectionChain (D-96) - root-first, including the collection's own level", () => {
    it("a root collection's chain is just its own level", async () => {
      const top = await createCollection({
        parentId: "",
        name: `chain-root-${randomUUID()}`,
        ownerSub: "user:a",
        protection: "secret",
      });
      createdCollectionIds.push(top.id);
      expect(await protectionChain(top.id)).toEqual(["secret"]);
    });

    it("a nested collection's chain walks root-first down to itself", async () => {
      const top = await createCollection({
        parentId: "",
        name: `chain-top-${randomUUID()}`,
        ownerSub: "user:a",
        protection: "public",
      });
      createdCollectionIds.push(top.id);
      const mid = await createCollection({
        parentId: top.id,
        name: "mid",
        ownerSub: "user:a",
        protection: "unlisted",
      });
      createdCollectionIds.push(mid.id);
      const deep = await createCollection({
        parentId: mid.id,
        name: "deep",
        ownerSub: "user:a",
        protection: "private",
      });
      createdCollectionIds.push(deep.id);

      expect(await protectionChain(deep.id)).toEqual(["public", "unlisted", "private"]);
    });

    it("raising an ancestor's protection is reflected immediately, with no rewrite of the descendant's own stored level", async () => {
      const top = await createCollection({
        parentId: "",
        name: `chain-raise-${randomUUID()}`,
        ownerSub: "user:a",
        protection: "public",
      });
      createdCollectionIds.push(top.id);
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:a", protection: "unlisted" });
      createdCollectionIds.push(child.id);

      await setCollectionProtection(top.id, "private");
      expect(await protectionChain(child.id)).toEqual(["private", "unlisted"]);
      // D-97: the child's OWN stored level is untouched by raising the parent.
      expect((await resolveCollectionById(child.id))?.protection).toBe("unlisted");
    });

    it("throws rather than hangs if the depth bound is exceeded (cycle guard)", async () => {
      let parentId = "";
      let leafId = "";
      for (let i = 0; i < 34; i++) {
        const c = await createCollection({ parentId, name: `pc${i}`, ownerSub: "user:a" });
        createdCollectionIds.push(c.id);
        parentId = c.id;
        leafId = c.id;
      }
      await expect(protectionChain(leafId)).rejects.toThrow(/max depth/);
    });
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

  it("renameCollection is a single UPDATE", async () => {
    const collection = await createCollection({ parentId: "", name: `old-${randomUUID()}`, ownerSub: "user:a" });
    createdCollectionIds.push(collection.id);
    await renameCollection(collection.id, "brand-new-name");
    expect(await resolveCollectionByNames(["brand-new-name"])).toMatchObject({ id: collection.id });
  });

  // D-82/D-130 (E4.1 live-testing findings, Wave C): a move is a plain UPDATE of parent_id.
  describe("moveCollection / isDescendantOf", () => {
    it("moveCollection updates parent_id; the collection resolves under its new parent's path", async () => {
      const a = await createCollection({ parentId: "", name: `move-a-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(a.id);
      const b = await createCollection({ parentId: "", name: `move-b-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(b.id);
      const moving = await createCollection({ parentId: a.id, name: "moving", ownerSub: "user:a" });
      createdCollectionIds.push(moving.id);

      await moveCollection(moving.id, b.id);

      expect(await resolveCollectionByNames([a.name, "moving"])).toBeNull();
      expect(await resolveCollectionByNames([b.name, "moving"])).toMatchObject({ id: moving.id });
    });

    it("isDescendantOf is true for the collection itself and any nested descendant, false for an unrelated collection", async () => {
      const top = await createCollection({ parentId: "", name: `desc-top-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(top.id);
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:a" });
      createdCollectionIds.push(child.id);
      const grandchild = await createCollection({ parentId: child.id, name: "grandchild", ownerSub: "user:a" });
      createdCollectionIds.push(grandchild.id);
      const unrelated = await createCollection({ parentId: "", name: `desc-unrelated-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(unrelated.id);

      expect(await isDescendantOf(top.id, top.id)).toBe(true);
      expect(await isDescendantOf(top.id, child.id)).toBe(true);
      expect(await isDescendantOf(top.id, grandchild.id)).toBe(true);
      expect(await isDescendantOf(top.id, unrelated.id)).toBe(false);
    });
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

  describe("hasAnyUploadGrant (E7-QA1 §A2.1) - the coarse tus gate, NOT a per-destination authorization check", () => {
    it("is true for a sub holding a can_upload grant ANYWHERE, even on a collection unrelated to what's asked next", async () => {
      const collection = await createCollection({ parentId: "", name: `hug-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        sub,
      ]);
      expect(await hasAnyUploadGrant(sub)).toBe(true);
    });

    it("is false for a sub with a VIEW-only grant (can_upload = 0)", async () => {
      const collection = await createCollection({ parentId: "", name: `hug-view-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        collection.id,
        sub,
      ]);
      expect(await hasAnyUploadGrant(sub)).toBe(false);
    });

    it("is false for a sub with no grant anywhere", async () => {
      expect(await hasAnyUploadGrant(`user:${randomUUID()}`)).toBe(false);
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
        uploaderName: null,
      });
      const abs = path.join(root, ...diskRelPath(claimed).split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, "bytes");
      await commitFileRow(claimed.id, { bytes: 5, width: null, height: null, durationSeconds: null, textPreview: null, thumbName: null, isText: false });

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

  describe("countDescendants (D-88/D-104) - the delete confirmation's count, without deleting anything", () => {
    it("counts the collection itself, every nested collection and every file beneath them", async () => {
      const top = await createCollection({ parentId: "", name: `count-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(top.id);
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:a" });
      createdCollectionIds.push(child.id);

      const claimed = await claimFileRow({
        collectionId: child.id,
        name: "counted.txt",
        diskDir: "2026/07",
        diskName: `${randomUUID()}-counted.txt`,
        ownerSub: "user:a",
        uploaderSub: "user:a",
        protection: "unlisted",
        uploaderName: null,
      });
      // resolveById() below stat()s the real bytes and self-heals (deletes the row) if they're missing -
      // matching deleteCollectionRecursive's own test just above, which writes them for the same reason.
      const abs = path.join(root, ...diskRelPath(claimed).split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, "bytes");
      await commitFileRow(claimed.id, { bytes: 5, width: null, height: null, durationSeconds: null, textPreview: null, thumbName: null, isText: false });

      const counts = await countDescendants(top.id);
      expect(counts).toEqual({ collectionCount: 2, fileCount: 1 });

      // Nothing was actually removed.
      expect(await resolveCollectionById(top.id)).not.toBeNull();
      expect(await resolveCollectionById(child.id)).not.toBeNull();
      expect(await resolveById(claimed.id)).not.toBeNull();
    });

    it("a leaf collection with no children counts itself and zero files", async () => {
      const leaf = await createCollection({ parentId: "", name: `count-leaf-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(leaf.id);
      expect(await countDescendants(leaf.id)).toEqual({ collectionCount: 1, fileCount: 0 });
    });
  });

  describe("hasAclGrantOnChain (D-99 - a grant on ANY ancestor collection pierces down to what it contains)", () => {
    it("a grant directly on the collection is honoured", async () => {
      const collection = await createCollection({ parentId: "", name: `acl-direct-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        "user:granted",
      ]);
      expect(await hasAclGrantOnChain(collection.id, "user:granted")).toBe(true);
    });

    it("a grant on an ANCESTOR collection is honoured for a deeply nested descendant", async () => {
      const top = await createCollection({ parentId: "", name: `acl-top-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(top.id);
      const mid = await createCollection({ parentId: top.id, name: "mid", ownerSub: "user:a" });
      createdCollectionIds.push(mid.id);
      const deep = await createCollection({ parentId: mid.id, name: "deep", ownerSub: "user:a" });
      createdCollectionIds.push(deep.id);

      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        top.id,
        "user:granted",
      ]);
      expect(await hasAclGrantOnChain(deep.id, "user:granted")).toBe(true);
    });

    it("a stranger with no grant anywhere in the chain gets false", async () => {
      const top = await createCollection({ parentId: "", name: `acl-none-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(top.id);
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:a" });
      createdCollectionIds.push(child.id);
      expect(await hasAclGrantOnChain(child.id, "user:stranger")).toBe(false);
    });

    it("the root ('') is not a dangling parent - it is an empty chain, no ACL rows", async () => {
      expect(await hasAclGrantOnChain("", "user:anybody")).toBe(false);
    });
  });

  // E7 Wave A2: the write half of collection_acl. controllers/share.ts owns authorization; this suite
  // proves the plain SQL semantics, including D-184's view-vs-upload split.
  describe("grantCollectionAcl / revokeCollectionAcl / listCollectionGrants (E7)", () => {
    it("grant makes hasCollectionAclGrant true; revoke makes it false again", async () => {
      const collection = await createCollection({ parentId: "", name: `share-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = "user:grantee";

      expect(await hasCollectionAclGrant(collection.id, sub)).toBe(false);
      await grantCollectionAcl(collection.id, sub, false);
      expect(await hasCollectionAclGrant(collection.id, sub)).toBe(true);
      await revokeCollectionAcl(collection.id, sub);
      expect(await hasCollectionAclGrant(collection.id, sub)).toBe(false);
    });

    // D-184: hasAclGrantOnChain (read) ignores can_upload entirely, while canUploadTo (write) requires it -
    // a view-only grant must be visible to the former and NOT to the latter.
    it("a view-only grant (canUpload: false) reads via hasAclGrantOnChain but does NOT let canUploadTo pass", async () => {
      const collection = await createCollection({ parentId: "", name: `view-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = "user:viewer";

      await grantCollectionAcl(collection.id, sub, false);
      expect(await hasAclGrantOnChain(collection.id, sub)).toBe(true);
      expect(await canUploadTo(collection, { sub })).toBe(false);
    });

    it("re-granting the same sub with canUpload: true UPDATES the row rather than throwing", async () => {
      const collection = await createCollection({ parentId: "", name: `upgrade-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = "user:upgraded";

      await grantCollectionAcl(collection.id, sub, false);
      expect(await canUploadTo(collection, { sub })).toBe(false);

      await expect(grantCollectionAcl(collection.id, sub, true)).resolves.toBeUndefined();
      expect(await canUploadTo(collection, { sub })).toBe(true);
      expect(await listCollectionGrants(collection.id)).toEqual([{ sub, canUpload: true }]);
    });

    it("a grant on a parent collection reaches a file three levels down via hasAclGrantOnChain", async () => {
      const top = await createCollection({ parentId: "", name: `deep-grant-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(top.id);
      const mid = await createCollection({ parentId: top.id, name: "mid", ownerSub: "user:a" });
      createdCollectionIds.push(mid.id);
      const deep = await createCollection({ parentId: mid.id, name: "deep", ownerSub: "user:a" });
      createdCollectionIds.push(deep.id);

      await grantCollectionAcl(top.id, "user:deep-grantee", true);
      expect(await hasAclGrantOnChain(deep.id, "user:deep-grantee")).toBe(true);
    });

    it("listCollectionGrants returns every granted sub with its canUpload flag, sorted", async () => {
      const collection = await createCollection({ parentId: "", name: `list-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:bbbb", true);
      await grantCollectionAcl(collection.id, "user:aaaa", false);
      expect(await listCollectionGrants(collection.id)).toEqual([
        { sub: "user:aaaa", canUpload: false },
        { sub: "user:bbbb", canUpload: true },
      ]);
    });

    it("revoking a sub that was never granted is a no-op, never throws", async () => {
      const collection = await createCollection({ parentId: "", name: `noop-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await expect(revokeCollectionAcl(collection.id, "user:nobody")).resolves.toBeUndefined();
    });

    // Security invariant 6: matched byte-for-byte, never a prefix.
    it("round-trips a sub containing a colon (D-191's link:<id> shape) byte-for-byte", async () => {
      const collection = await createCollection({ parentId: "", name: `link-sub-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = `link:${randomUUID()}`;
      await grantCollectionAcl(collection.id, sub, true);
      expect(await hasCollectionAclGrant(collection.id, sub)).toBe(true);
      expect(await listCollectionGrants(collection.id)).toEqual([{ sub, canUpload: true }]);
    });

    // Review session 045: the negative half of invariant 6, on the chain walk as well as the direct read -
    // hasAclGrantOnChain and canUploadTo compare the request's sub in SQL too, so a collation that folds
    // case/accents/trailing space would hand a nested collection's whole subtree to the wrong account.
    // See migration 008.
    it.each([
      ["differing only in case", "user:byte-exact", "USER:BYTE-EXACT"],
      ["differing only by a trailing space", "user:byte-exact", "user:byte-exact "],
      ["differing only by an accent", "user:byte-exact", "user:byté-exact"],
      ["a prefix of the granted sub", "user:byte-exact", "user:byte"],
    ] as const)("a sub %s does NOT match the granted row, directly or up the chain", async (_label, granted, probe) => {
      const parent = await createCollection({ parentId: "", name: `bytes-${randomUUID()}`, ownerSub: "user:a" });
      const child = await createCollection({ parentId: parent.id, name: `child-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(parent.id, child.id);
      await grantCollectionAcl(parent.id, granted, true);

      expect(await hasCollectionAclGrant(parent.id, probe)).toBe(false);
      expect(await hasAclGrantOnChain(child.id, probe)).toBe(false);
      // ...and the real grant still works, so this is strictness, not a broken read path.
      expect(await hasAclGrantOnChain(child.id, granted)).toBe(true);
    });
  });

  // E8 Wave A5 (D-219/D-220): expiry enforcement on every collection-side ACL read. Each assertion below
  // asserts an ABSENCE of access and was run RED against the pre-Wave-A predicates before
  // COLLECTION_GRANT_LIVE was appended - a never-ran-red assertion proves nothing (see the hand-off's own
  // warning on this wave).
  describe("expiry enforcement (D-219/D-220, E8)", () => {
    function pastDate(): Date {
      return new Date(Date.now() - 60_000);
    }
    function futureDate(): Date {
      return new Date(Date.now() + 60_000);
    }

    it("granted_at is populated automatically on insert", async () => {
      const collection = await createCollection({ parentId: "", name: `granted-at-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:grantee", false);
      const [rows] = await getPool().query(
        "SELECT granted_at FROM collection_acl WHERE collection_id = ? AND sub = ?",
        [collection.id, "user:grantee"],
      );
      expect((rows as { granted_at: Date }[])[0]?.granted_at).toBeInstanceOf(Date);
    });

    it("hasCollectionAclGrant: an EXPIRED grant does NOT authorize", async () => {
      const collection = await createCollection({ parentId: "", name: `expired-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:grantee", false, pastDate());
      expect(await hasCollectionAclGrant(collection.id, "user:grantee")).toBe(false);
    });

    it("hasCollectionAclGrant: a NULL expiry authorizes (the ordinary-share case)", async () => {
      const collection = await createCollection({ parentId: "", name: `permanent-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:grantee", false, null);
      expect(await hasCollectionAclGrant(collection.id, "user:grantee")).toBe(true);
    });

    it("hasCollectionAclGrant: a FUTURE expiry authorizes", async () => {
      const collection = await createCollection({ parentId: "", name: `future-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:grantee", false, futureDate());
      expect(await hasCollectionAclGrant(collection.id, "user:grantee")).toBe(true);
    });

    it("hasAclGrantOnChain: an EXPIRED grant on an ancestor does NOT authorize", async () => {
      const top = await createCollection({ parentId: "", name: `expired-chain-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(top.id);
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:a" });
      createdCollectionIds.push(child.id);
      await grantCollectionAcl(top.id, "user:grantee", false, pastDate());
      expect(await hasAclGrantOnChain(child.id, "user:grantee")).toBe(false);
    });

    it("canUploadTo: an EXPIRED can_upload grant does NOT authorize", async () => {
      const collection = await createCollection({ parentId: "", name: `expired-upload-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:grantee", true, pastDate());
      expect(await canUploadTo(collection, { sub: "user:grantee" })).toBe(false);
    });

    it("hasAnyUploadGrant: an EXPIRED can_upload grant does not count", async () => {
      const collection = await createCollection({ parentId: "", name: `expired-any-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      const sub = `user:${randomUUID()}`;
      await grantCollectionAcl(collection.id, sub, true, pastDate());
      expect(await hasAnyUploadGrant(sub)).toBe(false);
    });

    it("listCollectionGrants omits an EXPIRED grant", async () => {
      const collection = await createCollection({ parentId: "", name: `list-expired-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      await grantCollectionAcl(collection.id, "user:live", false, futureDate());
      await grantCollectionAcl(collection.id, "user:dead", false, pastDate());
      expect(await listCollectionGrants(collection.id)).toEqual([{ sub: "user:live", canUpload: false }]);
    });

    it("listVisibleChildCollections omits a collection reachable only via an EXPIRED ACL grant", async () => {
      const parent = await createCollection({ parentId: "", name: `visible-expired-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(parent.id);
      const child = await createCollection({
        parentId: parent.id,
        name: "child",
        ownerSub: "user:a",
        protection: "private",
      });
      createdCollectionIds.push(child.id);
      await grantCollectionAcl(child.id, "user:grantee", false, pastDate());
      const ids = (await listVisibleChildCollections(parent.id, "user:grantee")).map((c) => c.id);
      expect(ids).not.toContain(child.id);
    });

    it("listLinkAuthorizedChildCollections omits a collection reachable only via an EXPIRED ACL grant", async () => {
      const parent = await createCollection({ parentId: "", name: `link-expired-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(parent.id);
      const child = await createCollection({
        parentId: parent.id,
        name: "child",
        ownerSub: "user:a",
        protection: "private",
      });
      createdCollectionIds.push(child.id);
      await grantCollectionAcl(child.id, "user:grantee", false, pastDate());
      const ids = (await listLinkAuthorizedChildCollections(parent.id, "user:grantee")).map((c) => c.id);
      expect(ids).not.toContain(child.id);
    });
  });

  // A1/A2/A7 (E4.1 live-testing findings, Wave A): the root sentinel must resolve as an empty chain
  // everywhere the ancestor walk is projected, never throw "dangling parent_id" - it is not a real row.
  describe("the root ('') sentinel resolves as an empty chain, not a dangling parent (D-126)", () => {
    it("collectionPath('') is []", async () => {
      expect(await collectionPath("")).toEqual([]);
    });

    it("protectionChain('') is []", async () => {
      expect(await protectionChain("")).toEqual([]);
    });

    it("collectionBreadcrumb('') is []", async () => {
      expect(await collectionBreadcrumb("")).toEqual([]);
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

  // E4.1 Wave A / D-107: closes E4-COLLECTION-TOKEN-UNRESOLVED - the test whose absence let a
  // collection's share link 404 in both shapes.
  describe("resolveCollectionByToken (D-107)", () => {
    it("resolves a collection by its link_token", async () => {
      const collection = await createCollection({ parentId: "", name: `tok-${randomUUID()}`, ownerSub: "user:a" });
      createdCollectionIds.push(collection.id);
      expect(await resolveCollectionByToken(collection.linkToken)).toMatchObject({ id: collection.id });
    });

    it("returns null for a token that matches no collection", async () => {
      expect(await resolveCollectionByToken(randomUUID())).toBeNull();
    });
  });

  describe("resolveCollectionEffective (D-96 applied to a collection itself)", () => {
    it("a root, public collection is effectively public", async () => {
      const top = await createCollection({
        parentId: "",
        name: `eff-root-${randomUUID()}`,
        ownerSub: "user:a",
        protection: "public",
      });
      createdCollectionIds.push(top.id);
      const resolved = await resolveCollectionEffective(top);
      expect(resolved.effectiveProtection).toBe("public");
    });

    it("a collection stored looser than its parent is EFFECTIVELY as restrictive as the parent, without rewriting its own stored level", async () => {
      const top = await createCollection({
        parentId: "",
        name: `eff-parent-${randomUUID()}`,
        ownerSub: "user:a",
        protection: "private",
      });
      createdCollectionIds.push(top.id);
      const child = await createCollection({
        parentId: top.id,
        name: "child",
        ownerSub: "user:a",
        protection: "public",
      });
      createdCollectionIds.push(child.id);

      const resolved = await resolveCollectionEffective(child);
      expect(resolved.effectiveProtection).toBe("private");
      expect(resolved.protection).toBe("public"); // the stored column is untouched (D-97)
    });
  });
});
