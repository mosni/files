import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerDeliveryRoutes } from "../../src/routes/delivery.ts";
import { registerContextRoutes } from "../../src/routes/context.ts";
import type { Config } from "../../src/config.ts";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { initFilesStorage } from "../../src/storage/files.ts";

const verifyMock = vi.mocked(verify);

const DL_HOST = "dl.mosni.dev";
const FILES_HOST = "files.mosni.dev";

describe("routes/delivery.ts + routes/context.ts (E5a - the security-critical routes)", () => {
  let root: string;
  let app: FastifyInstance;
  let config: Config;
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
    root = await mkdtemp(path.join(os.tmpdir(), "delivery-test-"));
    initFilesStorage(root);

    config = {
      db: { host: "mariadb", port: 3306, user: "files", pass: "filespass", name: "files" },
      redisUrl: "redis://redis:6379",
      botApi: "http://bot-core:8080",
      authIssuer: "https://auth.mosni.dev",
      appOrigin: `https://${FILES_HOST}`,
      dlOrigin: `https://${DL_HOST}`,
      storageRoot: root,
      tusTempDir: path.join(root, ".tus"),
      port: 0,
    };

    app = Fastify({ logger: false });
    await registerDeliveryRoutes(app, config);
    await registerContextRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    vi.mocked(verify).mockReset();
    while (createdCollectionNames.length > 0) {
      const name = createdCollectionNames.pop()!;
      await getPool().query(
        "DELETE FROM file_acl WHERE collection_id IN (SELECT id FROM collections WHERE name = ?)",
        [name],
      );
      await getPool().query(
        "DELETE FROM files WHERE collection_id IN (SELECT id FROM collections WHERE name = ?)",
        [name],
      );
      await getPool().query("DELETE FROM collections WHERE name = ?", [name]);
    }
  });

  // Seeds a collection + file directly (DB row + real bytes on disk), bypassing upload/reconcile so each
  // test controls protection level and ownership precisely.
  async function seedFile(opts: {
    protection: "public" | "unlisted" | "secret" | "private";
    ownerSub?: string | null;
    content?: string;
  }): Promise<{ collection: string; name: string; linkToken: string }> {
    const collection = `coll-${randomUUID()}`;
    createdCollectionNames.push(collection);
    const collectionId = randomUUID();
    await getPool().query(
      "INSERT INTO collections (id, owner_sub, name, protection, is_default) VALUES (?, ?, ?, ?, FALSE)",
      [collectionId, opts.ownerSub ?? null, collection, opts.protection],
    );

    await mkdir(path.join(root, collection), { recursive: true });
    const name = "file.txt";
    const content = opts.content ?? "test content";
    await writeFile(path.join(root, collection, name), content);

    const linkToken = randomUUID().replace(/-/g, "").slice(0, 22);
    await getPool().query(
      "INSERT INTO files (collection_id, display_name, bytes, protection, link_token, uploader_sub) VALUES (?, ?, ?, ?, ?, NULL)",
      [collectionId, name, content.length, opts.protection, linkToken],
    );

    return { collection, name, linkToken };
  }

  describe("readable-path delivery (/:collection/:name on dl.mosni.dev)", () => {
    it("serves public and unlisted files via X-Accel-Redirect with an empty body", async () => {
      for (const protection of ["public", "unlisted"] as const) {
        const { collection, name } = await seedFile({ protection });
        const res = await app.inject({
          method: "GET",
          url: `/${collection}/${name}`,
          headers: { host: DL_HOST },
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(""); // Node never streams bytes (D-5)
        expect(res.headers["x-accel-redirect"]).toBe(
          `/internal-storage/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`,
        );
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
      }
    });

    it("returns 404, not 403, for a secret file requested at its readable path (D-59 mandatory test)", async () => {
      const { collection, name } = await seedFile({ protection: "secret" });
      const res = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST },
      });
      expect(res.statusCode).toBe(404);
    });

    it("gets Content-Disposition: attachment for a non-allowlisted extension", async () => {
      const collection = `coll-${randomUUID()}`;
      createdCollectionNames.push(collection);
      const collectionId = randomUUID();
      await getPool().query(
        "INSERT INTO collections (id, owner_sub, name, protection, is_default) VALUES (?, NULL, ?, 'public', FALSE)",
        [collectionId, collection],
      );
      await mkdir(path.join(root, collection), { recursive: true });
      await writeFile(path.join(root, collection, "archive.zip"), "not really a zip");
      const linkToken = randomUUID().replace(/-/g, "").slice(0, 22);
      await getPool().query(
        "INSERT INTO files (collection_id, display_name, bytes, protection, link_token, uploader_sub) VALUES (?, 'archive.zip', 17, 'public', ?, NULL)",
        [collectionId, linkToken],
      );

      const res = await app.inject({
        method: "GET",
        url: `/${collection}/archive.zip`,
        headers: { host: DL_HOST },
      });
      expect(res.headers["content-disposition"]).toContain("attachment");
    });

    it("returns 404 for a file that does not exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/${randomUUID()}/nope.txt`,
        headers: { host: DL_HOST },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("token delivery (bare single segment on dl.mosni.dev)", () => {
    it("resolves a secret file's token even though its readable path 404s", async () => {
      const { linkToken, collection, name } = await seedFile({ protection: "secret" });
      const res = await app.inject({ method: "GET", url: `/${linkToken}`, headers: { host: DL_HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-accel-redirect"]).toBe(
        `/internal-storage/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`,
      );
    });

    it("404s a single segment that is not token-shaped", async () => {
      const res = await app.inject({ method: "GET", url: "/not-a-token", headers: { host: DL_HOST } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("private files (security invariant 6 - byte-for-byte sub matching)", () => {
    it("401s a private file with no bearer token", async () => {
      const { collection, name } = await seedFile({ protection: "private", ownerSub: "user:owner" });
      const res = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST },
      });
      expect(res.statusCode).toBe(401);
    });

    it("403s a private file for a verified but unauthorized sub", async () => {
      const { collection, name } = await seedFile({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:someone-else", roles: [] } as never);
      const res = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST, authorization: "Bearer whatever" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("200s a private file for its owner", async () => {
      const { collection, name } = await seedFile({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      const res = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST, authorization: "Bearer whatever" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("200s a private file for files:admin, regardless of ownership", async () => {
      const { collection, name } = await seedFile({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:admin", roles: ["files:admin"] } as never);
      const res = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST, authorization: "Bearer whatever" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("200s a private file for a sub with an exact ACL grant, and 403s a near-miss sub (byte-for-byte, never parsed)", async () => {
      const { collection, name } = await seedFile({ protection: "private", ownerSub: "user:owner" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query(
        `INSERT INTO file_acl (collection_id, display_name, sub)
         VALUES ((SELECT id FROM collections WHERE name = ?), ?, ?)`,
        [collection, name, grantedSub],
      );

      verifyMock.mockResolvedValue({ sub: grantedSub, roles: [] } as never);
      const grantedRes = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST, authorization: "Bearer whatever" },
      });
      expect(grantedRes.statusCode).toBe(200);

      verifyMock.mockResolvedValue({ sub: grantedSub.slice(0, -1), roles: [] } as never);
      const nearMissRes = await app.inject({
        method: "GET",
        url: `/${collection}/${name}`,
        headers: { host: DL_HOST, authorization: "Bearer whatever" },
      });
      expect(nearMissRes.statusCode).toBe(403);
    });
  });

  describe("GET /api/f/:token/context (D-63 island probe)", () => {
    it("returns false/false for an anonymous request", async () => {
      const { linkToken } = await seedFile({ protection: "unlisted" });
      const res = await app.inject({
        method: "GET",
        url: `/api/f/${linkToken}/context`,
        headers: { host: FILES_HOST },
      });
      expect(res.json()).toEqual({ canEdit: false, canDelete: false });
    });

    it("returns true/true for the owner", async () => {
      const { linkToken } = await seedFile({ protection: "unlisted", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      const res = await app.inject({
        method: "GET",
        url: `/api/f/${linkToken}/context`,
        headers: { host: FILES_HOST, authorization: "Bearer whatever" },
      });
      expect(res.json()).toEqual({ canEdit: true, canDelete: true });
    });

    it("gives files:delete canDelete but not canEdit for a non-owner (D-22 - delete is global, write is not)", async () => {
      const { linkToken } = await seedFile({ protection: "unlisted", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:deleter", roles: ["files:delete"] } as never);
      const res = await app.inject({
        method: "GET",
        url: `/api/f/${linkToken}/context`,
        headers: { host: FILES_HOST, authorization: "Bearer whatever" },
      });
      expect(res.json()).toEqual({ canEdit: false, canDelete: true });
    });

    it("404s for a token that does not exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/f/AAAAAAAAAAAAAAAAAAAAAA/context",
        headers: { host: FILES_HOST },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("D-60 end to end via the delivery route", () => {
    it("an uploaded/reconciled JPEG with GPS EXIF has none in the bytes X-Accel-Redirect points at", async () => {
      const sharp = (await import("sharp")).default;
      const collection = `coll-${randomUUID()}`;
      createdCollectionNames.push(collection);
      await mkdir(path.join(root, collection), { recursive: true });
      const filePath = path.join(root, collection, "photo.jpg");
      await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg()
        .withExif({ IFD3: { GPSLatitude: "1/1 0/1 0/1", GPSLatitudeRef: "N" } })
        .toFile(filePath);

      // resolveByPath reconciles the hand-copied file (strips it) the first time it's touched - exactly
      // what the readable-path delivery route does internally.
      const { resolveByPath } = await import("../../src/storage/files.ts");
      const record = await resolveByPath(collection, "photo.jpg");
      expect(record).not.toBeNull();

      const res = await app.inject({
        method: "GET",
        url: `/${collection}/photo.jpg`,
        headers: { host: DL_HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("");

      const after = await sharp(filePath).metadata();
      expect(after.exif).toBeUndefined();
    });
  });
});
