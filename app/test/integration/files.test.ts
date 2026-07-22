import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import {
  deleteFileRow,
  hasAclGrant,
  initFilesStorage,
  insertUploadedFile,
  resolveByPath,
  resolveByToken,
} from "../../src/storage/files.ts";
import type { Protection } from "../../src/lib/protection.ts";

// Against real MariaDB and a real temp directory. Session 007 model (P7): no reconciliation - a row exists
// only because an upload created it; a lookup queries the row and stats the one path it names.
describe("storage/files.ts - no reconciliation, path-keyed (P6/P7)", () => {
  let root: string;
  const createdPaths: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applySchema();
    root = await mkdtemp(path.join(os.tmpdir(), "files-test-"));
    initFilesStorage(root);
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  }, 30_000);

  afterEach(async () => {
    while (createdPaths.length > 0) {
      await deleteFileRow(createdPaths.pop()!);
    }
  });

  // Seeds both the DB row and the bytes on disk, so resolveByPath/Token find a consistent pair.
  async function seed(opts: {
    relPath?: string;
    protection?: Protection;
    ownerSub?: string | null;
    content?: string;
  }): Promise<{ relPath: string; linkToken: string }> {
    const relPath = opts.relPath ?? `u-${randomUUID()}/file.txt`;
    createdPaths.push(relPath);
    const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
    const content = opts.content ?? "content";
    const abs = path.join(root, ...relPath.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    await getPool().query(
      "INSERT INTO files (path, bytes, protection, link_token, owner_sub, uploader_sub) VALUES (?, ?, ?, ?, ?, ?)",
      [relPath, content.length, opts.protection ?? "unlisted", linkToken, opts.ownerSub ?? null, null],
    );
    return { relPath, linkToken };
  }

  it("resolveByPath returns the record for an indexed file present on disk", async () => {
    const { relPath } = await seed({ relPath: `h-${randomUUID()}/photo.png`, protection: "public", content: "abcd" });
    const record = await resolveByPath(relPath);
    expect(record).toMatchObject({ path: relPath, name: "photo.png", bytes: 4, protection: "public" });
    expect(record!.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);
  });

  it("resolveByPath resolves an arbitrarily nested path (P6 deep nesting)", async () => {
    const relPath = `n-${randomUUID()}/2026/trip/beach.jpg`;
    await seed({ relPath });
    const record = await resolveByPath(relPath);
    expect(record?.path).toBe(relPath);
    expect(record?.name).toBe("beach.jpg");
  });

  it("resolveByPath returns null for a file on disk that has NO row (no drop-in, P7)", async () => {
    const folder = `orphan-${randomUUID()}`;
    await mkdir(path.join(root, folder), { recursive: true });
    await writeFile(path.join(root, folder, "hand.txt"), "x"); // written, never indexed
    expect(await resolveByPath(`${folder}/hand.txt`)).toBeNull();
  });

  it("resolveByPath cleans up and returns null when the row exists but the bytes are gone (D-16)", async () => {
    const { relPath } = await seed({});
    await unlink(path.join(root, ...relPath.split("/")));
    expect(await resolveByPath(relPath)).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE path = ?", [relPath]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByPath returns null for an unsafe/traversal path", async () => {
    expect(await resolveByPath("../../etc/passwd")).toBeNull();
    expect(await resolveByPath("a/../../etc")).toBeNull();
  });

  it("resolveByToken resolves by token, and cleans up a dead one", async () => {
    const { relPath, linkToken } = await seed({});
    expect((await resolveByToken(linkToken))?.path).toBe(relPath);

    await unlink(path.join(root, ...relPath.split("/")));
    expect(await resolveByToken(linkToken)).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE link_token = ?", [linkToken]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByToken returns null for an unknown token", async () => {
    expect(await resolveByToken("ZZZZZ")).toBeNull();
  });

  it("insertUploadedFile records the uploader and a shaped token, resolvable by both path and token", async () => {
    const relPath = `up-${randomUUID()}/uploaded.txt`;
    createdPaths.push(relPath);
    await mkdir(path.join(root, path.dirname(relPath)), { recursive: true });
    await writeFile(path.join(root, ...relPath.split("/")), "hello");

    const record = await insertUploadedFile({
      path: relPath,
      bytes: 5,
      protection: "unlisted",
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
    });
    expect(record.uploaderSub).toBe("user:owner");
    expect(record.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(record.createdAt).toEqual(expect.any(String));
    expect((await resolveByPath(relPath))?.ownerSub).toBe("user:owner");
    expect((await resolveByToken(record.linkToken))?.path).toBe(relPath);
  });

  it("insertUploadedFile stores captured media dimensions (D-74)", async () => {
    const relPath = `up-${randomUUID()}/photo.png`;
    createdPaths.push(relPath);
    await mkdir(path.join(root, path.dirname(relPath)), { recursive: true });
    await writeFile(path.join(root, ...relPath.split("/")), "hello");

    await insertUploadedFile({
      path: relPath,
      bytes: 5,
      protection: "unlisted",
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      width: 640,
      height: 480,
      durationSeconds: 12.5,
      textPreview: null,
    });
    const record = await resolveByPath(relPath);
    expect(record?.width).toBe(640);
    expect(record?.height).toBe(480);
    expect(record?.durationSeconds).toBe(12.5);
  });

  describe("hasAclGrant (security invariant 6 - byte-for-byte, never parsed)", () => {
    it("matches only the exact sub granted", async () => {
      const { relPath } = await seed({ protection: "private", ownerSub: "user:owner" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO file_acl (path, sub) VALUES (?, ?)", [relPath, grantedSub]);

      expect(await hasAclGrant(relPath, grantedSub)).toBe(true);
      expect(await hasAclGrant(relPath, grantedSub.slice(0, -1))).toBe(false);
      expect(await hasAclGrant(relPath, `${grantedSub}x`)).toBe(false);
    });

    it("returns false when no grant exists", async () => {
      const { relPath } = await seed({ protection: "private", ownerSub: "user:owner" });
      expect(await hasAclGrant(relPath, `user:${randomUUID()}`)).toBe(false);
    });
  });
});
