import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import {
  hasAclGrant,
  initFilesStorage,
  insertUploadedFile,
  listCollection,
  resolveByPath,
  resolveByToken,
} from "../../src/storage/files.ts";
import { getCollectionByName, getOrCreateCollectionForDiskEntry } from "../../src/storage/collections.ts";

// Against real MariaDB and a real temp directory (D-45). This is the D-56 acceptance suite: the
// filesystem is the source of truth, and a file copied into the storage tree by hand must become
// downloadable with no upload, no restart, and no manual trigger.
describe("storage/files.ts - lazy, request-scoped reconciliation (D-56/D-57)", () => {
  let root: string;
  const createdCollectionNames: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applySchema();
    root = await mkdtemp(path.join(os.tmpdir(), "reconcile-test-"));
    initFilesStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  });

  afterEach(async () => {
    while (createdCollectionNames.length > 0) {
      const name = createdCollectionNames.pop()!;
      await getPool().query("DELETE FROM file_acl WHERE collection_id IN (SELECT id FROM collections WHERE name = ?)", [name]);
      await getPool().query("DELETE FROM files WHERE collection_id IN (SELECT id FROM collections WHERE name = ?)", [name]);
      await getPool().query("DELETE FROM collections WHERE name = ?", [name]);
    }
  });

  async function freshCollectionDir(): Promise<string> {
    const name = `coll-${randomUUID()}`;
    createdCollectionNames.push(name);
    await mkdir(path.join(root, name));
    return name;
  }

  it("a file written directly to disk (never uploaded) appears in listCollection() - the D-56 acceptance test", async () => {
    const collection = await freshCollectionDir();
    await writeFile(path.join(root, collection, "dropped-in.txt"), "hand-copied content");

    const records = await listCollection(collection);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      collection,
      name: "dropped-in.txt",
      bytes: "hand-copied content".length,
      protection: "unlisted",
      uploaderSub: null,
      ownerSub: null,
    });
    expect(records[0]!.linkToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("the reconciled row persists - a second listCollection() call does not duplicate it", async () => {
    const collection = await freshCollectionDir();
    await writeFile(path.join(root, collection, "photo.txt"), "x");

    const first = await listCollection(collection);
    const second = await listCollection(collection);

    expect(first[0]!.linkToken).toBe(second[0]!.linkToken);
    const [rows] = await getPool().query(
      "SELECT COUNT(*) AS n FROM files WHERE collection_id = (SELECT id FROM collections WHERE name = ?)",
      [collection],
    );
    expect((rows as { n: number }[])[0]?.n).toBe(1);
  });

  it("a file deleted from disk disappears from the listing and its row is gone", async () => {
    const collection = await freshCollectionDir();
    const filePath = path.join(root, collection, "temporary.txt");
    await writeFile(filePath, "x");
    await listCollection(collection); // reconcile: insert the row

    await unlink(filePath);
    const records = await listCollection(collection);

    expect(records).toHaveLength(0);
    const [rows] = await getPool().query(
      "SELECT COUNT(*) AS n FROM files WHERE collection_id = (SELECT id FROM collections WHERE name = ?)",
      [collection],
    );
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("a bare mkdir produces an unowned, unlisted collection on first touch", async () => {
    const collection = await freshCollectionDir(); // mkdir only, no upload flow ever ran

    await listCollection(collection); // the "touch" that triggers auto-creation

    const row = await getCollectionByName(collection);
    expect(row?.ownerSub).toBeNull();
    expect(row?.protection).toBe("unlisted");
  });

  it("resolveByPath() reconciles a single hand-copied file the same way listCollection() does", async () => {
    const collection = await freshCollectionDir();
    await writeFile(path.join(root, collection, "single.txt"), "content");

    const record = await resolveByPath(collection, "single.txt");

    expect(record).toMatchObject({ collection, name: "single.txt", protection: "unlisted" });
  });

  it("resolveByPath() returns null for a file that does not exist on disk", async () => {
    const collection = await freshCollectionDir();
    const record = await resolveByPath(collection, "does-not-exist.txt");
    expect(record).toBeNull();
  });

  it("resolveByPath() returns null for a collection that has neither a row nor a directory", async () => {
    const record = await resolveByPath(`nonexistent-${randomUUID()}`, "anything.txt");
    expect(record).toBeNull();
  });

  it("resolveByToken() resolves a previously-reconciled file by its token", async () => {
    const collection = await freshCollectionDir();
    await writeFile(path.join(root, collection, "tokened.txt"), "content");
    const reconciled = await resolveByPath(collection, "tokened.txt");

    const byToken = await resolveByToken(reconciled!.linkToken);

    expect(byToken).toMatchObject({ collection, name: "tokened.txt" });
  });

  it("resolveByToken() on a file whose bytes were deleted returns null and cleans up the row (D-16)", async () => {
    const collection = await freshCollectionDir();
    const filePath = path.join(root, collection, "will-vanish.txt");
    await writeFile(filePath, "content");
    const reconciled = await resolveByPath(collection, "will-vanish.txt");
    const token = reconciled!.linkToken;

    await unlink(filePath);
    const result = await resolveByToken(token);

    expect(result).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE link_token = ?", [token]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByToken() returns null for a token that was never issued", async () => {
    const result = await resolveByToken("AAAAAAAAAAAAAAAAAAAAAA");
    expect(result).toBeNull();
  });

  it("a hand-copied JPEG with GPS EXIF is stripped as part of first reconciliation (D-60 end to end)", async () => {
    const collection = await freshCollectionDir();
    const jpegPath = path.join(root, collection, "with-gps.jpg");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitude: "51/1 0/1 0/1", GPSLatitudeRef: "N" } })
      .toFile(jpegPath);

    await listCollection(collection); // triggers reconcile + strip

    const after = await sharp(jpegPath).metadata();
    expect(after.exif).toBeUndefined();
  });

  it("a file that fails to strip is excluded from the listing and its row is rolled back", async () => {
    const collection = await freshCollectionDir();
    // A ".jpg" that isn't actually a valid JPEG - sharp will fail to inspect/rewrite it.
    await writeFile(path.join(root, collection, "corrupt.jpg"), "not a real jpeg");

    const records = await listCollection(collection);

    expect(records).toHaveLength(0);
    const [rows] = await getPool().query(
      "SELECT COUNT(*) AS n FROM files WHERE collection_id = (SELECT id FROM collections WHERE name = ?)",
      [collection],
    );
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  describe("hasAclGrant() (security invariant 6 - byte-for-byte sub match, never parsed)", () => {
    it("returns true only for the exact sub granted, never a prefix or fragment", async () => {
      const collection = await freshCollectionDir();
      await writeFile(path.join(root, collection, "shared.txt"), "content");
      await resolveByPath(collection, "shared.txt"); // reconcile so a files row exists

      const grantedSub = `user:${randomUUID()}`;
      await getPool().query(
        `INSERT INTO file_acl (collection_id, display_name, sub)
         VALUES ((SELECT id FROM collections WHERE name = ?), ?, ?)`,
        [collection, "shared.txt", grantedSub],
      );

      expect(await hasAclGrant(collection, "shared.txt", grantedSub)).toBe(true);
      expect(await hasAclGrant(collection, "shared.txt", grantedSub.slice(0, -1))).toBe(false);
      expect(await hasAclGrant(collection, "shared.txt", `${grantedSub}x`)).toBe(false);
      expect(await hasAclGrant(collection, "shared.txt", `other-${randomUUID()}`)).toBe(false);
    });

    it("returns false when no grant exists at all", async () => {
      const collection = await freshCollectionDir();
      await writeFile(path.join(root, collection, "unshared.txt"), "content");
      await resolveByPath(collection, "unshared.txt");

      expect(await hasAclGrant(collection, "unshared.txt", `user:${randomUUID()}`)).toBe(false);
    });
  });

  describe("insertUploadedFile() (D2's commit path - distinct from reconciliation's insert)", () => {
    it("records the real uploader sub, unlike a reconciled hand-copied file", async () => {
      const collectionName = await freshCollectionDir();
      const collection = await getOrCreateCollectionForDiskEntry(root, collectionName);
      const uploaderSub = `user:${randomUUID()}`;
      // insertUploadedFile only writes the DB row (D2's caller already renamed the bytes to their final
      // path before calling it) - resolveByToken() below still stats the real file, so it must exist.
      const content = "already-uploaded-and-stripped-content";
      await writeFile(path.join(root, collectionName, "uploaded.txt"), content);

      const record = await insertUploadedFile(collection!, "uploaded.txt", content.length, uploaderSub);

      expect(record.uploaderSub).toBe(uploaderSub);
      expect(record.protection).toBe(collection!.protection);
      expect(record.linkToken).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const resolved = await resolveByToken(record.linkToken);
      expect(resolved?.uploaderSub).toBe(uploaderSub);
    });
  });
});
