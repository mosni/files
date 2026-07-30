import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import sharp from "sharp";

// auth.mosni.dev is not reachable from this sandbox - there is no live IdP to test against here (unlike
// MariaDB/redis, which are real Docker services this suite already depends on). Mocking verify() is the
// only way to exercise the route's authorized paths at all; unauthorized paths (missing/garbage token)
// need no mock and are covered separately below.
vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerUploadRoutes } from "../../src/routes/upload.ts";
import type { Config } from "../../src/config.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { diskRelPath, initFilesStorage, resolveByNames } from "../../src/storage/files.ts";
import { createCollection, listCollectionsFor } from "../../src/storage/collections.ts";

const verifyMock = vi.mocked(verify);

describe("routes/upload.ts - tus upload, insert-then-move commit (D-85)", () => {
  let root: string;
  let app: FastifyInstance;
  let redis: Redis;
  let config: Config;
  const createdOwnerSubs: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();

    root = await mkdtemp(path.join(os.tmpdir(), "upload-test-"));
    initFilesStorage(root);

    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");

    config = {
      db: { host: "mariadb", port: 3306, user: "files", pass: "filespass", name: "files" },
      redisUrl: "redis://redis:6379",
      botApi: "http://bot-core:8080",
      authIssuer: "https://auth.mosni.dev",
      appOrigin: "https://files.mosni.dev",
      dlOrigin: "https://dl.mosni.dev",
      storageRoot: root,
      tusTempDir: path.join(root, ".tus"),
      port: 0,
      deliverySigningSecret: "upload-test-secret",
      deliveryUrlTtlSeconds: 300,
    };

    app = Fastify({ logger: false });
    await registerUploadRoutes(app, config, redis);
    await app.listen({ port: 0, host: "127.0.0.1" });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    vi.mocked(verify).mockReset();
    while (createdOwnerSubs.length > 0) {
      const ownerSub = createdOwnerSubs.pop()!;
      // D-126: a default upload now lands at collection_id = '' (the root), not inside a per-user default
      // collection - clean those up directly, in addition to the (still real, explicitly-created)
      // collections owned by this sub below.
      const [rootFileRows] = await getPool().query("SELECT id FROM files WHERE collection_id = '' AND owner_sub = ?", [
        ownerSub,
      ]);
      for (const fileRow of rootFileRows as { id: string }[]) {
        await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [fileRow.id]);
        await getPool().query("DELETE FROM files WHERE id = ?", [fileRow.id]);
      }
      const [collectionRows] = await getPool().query("SELECT id FROM collections WHERE owner_sub = ?", [ownerSub]);
      for (const row of collectionRows as { id: string }[]) {
        const [fileRows] = await getPool().query("SELECT id FROM files WHERE collection_id = ?", [row.id]);
        for (const fileRow of fileRows as { id: string }[]) {
          await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [fileRow.id]);
          await getPool().query("DELETE FROM files WHERE id = ?", [fileRow.id]);
        }
        await getPool().query("DELETE FROM collections WHERE id = ?", [row.id]);
      }
    }
  });

  function baseUrl(): string {
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("server not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  // The tus routes are host-constrained to config.appOrigin's hostname (D-33: no app surface on the
  // containment origin), and these tests reach the server over a real socket on 127.0.0.1 - so every
  // request has to spell out the Host nginx would forward in production.
  const FILES_HOST = "files.mosni.dev";

  type TestResponse = {
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  };

  // node:http rather than fetch: undici treats `host` as a forbidden header and silently drops it, so
  // fetch cannot exercise a host-constrained route at all. Real sockets and a real request/response
  // still matter here - tus is bridged via reply.hijack() onto the raw streams, which app.inject()
  // does not model.
  function request(
    url: string,
    options: { method: string; headers: Record<string, string>; body?: Buffer },
  ): Promise<TestResponse> {
    return new Promise((resolve, reject) => {
      const target = new URL(url, baseUrl());
      const local = new URL(baseUrl());
      const req = http.request(
        {
          hostname: local.hostname,
          port: local.port,
          path: `${target.pathname}${target.search}`,
          method: options.method,
          headers: { ...options.headers, host: FILES_HOST },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              headers: { get: (name) => (res.headers[name.toLowerCase()] as string) ?? null },
              json: async () => JSON.parse(text) as unknown,
            });
          });
        },
      );
      req.on("error", reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  function mockAuthorizedAs(sub: string, extra: Record<string, unknown> = {}): void {
    verifyMock.mockResolvedValue({ sub, roles: ["files:write"], ...extra } as never);
  }

  function encodeMetadata(fields: Record<string, string>): string {
    return Object.entries(fields)
      .map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`)
      .join(",");
  }

  async function createUpload(
    token: string | null,
    length: number,
    metadata: Record<string, string>,
  ): Promise<TestResponse> {
    return request(`${baseUrl()}/api/upload`, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(length),
        "Upload-Metadata": encodeMetadata(metadata),
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  }

  async function patchUpload(
    uploadUrl: string,
    token: string,
    offset: number,
    chunk: Buffer,
  ): Promise<TestResponse> {
    return request(uploadUrl, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(chunk.length),
        Authorization: `Bearer ${token}`,
      },
      body: chunk,
    });
  }

  it("is not throttled by the global 100/min rate limit (D1's dedicated 600/min scope)", async () => {
    const responses = await Promise.all(
      Array.from({ length: 105 }, () =>
        request(`${baseUrl()}/api/upload`, {
          method: "OPTIONS",
          headers: { "Tus-Resumable": "1.0.0" },
        }),
      ),
    );
    expect(responses.every((res) => res.status !== 429)).toBe(true);
  });

  it("rejects an upload with no bearer token (401)", async () => {
    const res = await createUpload(null, 5, { filename: "x.txt" });
    expect(res.status).toBe(401);
  });

  it("rejects an upload from a token that lacks files:write (403)", async () => {
    verifyMock.mockResolvedValue({ sub: "user:no-write", roles: [] } as never);
    const res = await createUpload("some-token", 5, { filename: "x.txt" });
    expect(res.status).toBe(403);
  });

  it("rejects an upload from an invalid/unverifiable token (401)", async () => {
    verifyMock.mockRejectedValue(new Error("bad signature"));
    const res = await createUpload("garbage", 5, { filename: "x.txt" });
    expect(res.status).toBe(401);
  });

  it("completes the full tus lifecycle (create -> offset -> resume -> completion), lands committed, and returns preview/direct URLs", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    mockAuthorizedAs(uploaderSub);
    createdOwnerSubs.push(uploaderSub);

    const content = Buffer.from("hello from the tus lifecycle test");
    const createRes = await createUpload(uploaderSub, content.length, {
      filename: "greeting.txt",
    });
    expect(createRes.status).toBe(201);
    const location = createRes.headers.get("location");
    expect(location).toBeTruthy();
    const uploadUrl = new URL(location!, baseUrl()).toString();

    // First chunk.
    const firstChunk = content.subarray(0, 10);
    const patch1 = await patchUpload(uploadUrl, uploaderSub, 0, firstChunk);
    expect(patch1.status).toBe(204);
    expect(patch1.headers.get("upload-offset")).toBe(String(firstChunk.length));

    // "Resume": a HEAD request confirms the server-side offset before continuing, exactly as a resumed
    // client would after a dropped connection.
    const headRes = await request(uploadUrl, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", Authorization: `Bearer ${uploaderSub}` },
    });
    expect(headRes.headers.get("upload-offset")).toBe(String(firstChunk.length));

    // Final chunk completes the upload. 200, not 204: a 204 response cannot carry a body (Node's
    // http.ServerResponse enforces this), and returning the preview/direct URLs needs one.
    const secondChunk = content.subarray(10);
    const patch2 = await patchUpload(uploadUrl, uploaderSub, firstChunk.length, secondChunk);
    expect(patch2.status).toBe(200);

    const body = (await patch2.json()) as { previewUrl: string; directUrl: string };
    // D-126: no destination given -> the ROOT, not a per-user default collection. unlisted (the root's
    // default protection) resolves at the readable /f/<name> preview and plain dl/<name> path, not a
    // token, and with no collection segment at all.
    expect(body.previewUrl).toBe("https://files.mosni.dev/f/greeting.txt");
    expect(body.directUrl).toBe("https://dl.mosni.dev/greeting.txt");

    // AC1/AC2: no collections row is created for this uploader at all - the old sub-leak fallback
    // (D-92/session 016) never fires because there is no name left to derive.
    expect(await listCollectionsFor(uploaderSub)).toEqual([]);

    const record = await resolveByNames(["greeting.txt"]);
    expect(record).not.toBeNull();
    expect(record?.collectionId).toBe("");
    expect(record?.protection).toBe("unlisted");

    const writtenPath = path.join(root, diskRelPath(record!));
    expect((await readFile(writtenPath)).toString()).toBe(content.toString());
    // D-82: the disk name carries the ORIGINAL filename with a fresh id prefix, never the display name
    // verbatim.
    expect(record!.diskName.endsWith("-greeting.txt")).toBe(true);
    expect(record!.diskName).not.toBe("greeting.txt");
  });

  // AC3/AC4 (E4.1 live-testing findings, Wave A): a root file has no ancestor chain, so any protection
  // level including public becomes settable, and a name that would shadow /t/:token is suffixed.
  it("a root-level file uploaded with the reserved name 't' is stored as 't-file' (D-126/A5, avoids shadowing /t/<token>)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const content = Buffer.from("shadow-avoidance");
    const createRes = await createUpload(uploaderSub, content.length, { filename: "t" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, content);
    expect(patchRes.status).toBe(200);

    expect(await resolveByNames(["t"])).toBeNull();
    const record = await resolveByNames(["t-file"]);
    expect(record).not.toBeNull();
    expect(record?.collectionId).toBe("");
  });

  it("rejects a traversal-shaped filename and leaves nothing on disk or in the DB", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const content = Buffer.from("malicious");
    const createRes = await createUpload(uploaderSub, content.length, {
      filename: "../../../etc/passwd",
    });
    expect(createRes.status).toBe(201);
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();

    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, content);
    expect(patchRes.status).toBe(400);

    // No collection was ever created either - the filename is rejected before any destination resolves.
    expect(await listCollectionsFor(uploaderSub)).toEqual([]);
  });

  it("uploads to the ROOT unless a valid destinationCollectionId is given (D-126)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const other = await createCollection({ parentId: "", name: `dest-${randomUUID()}`, ownerSub: uploaderSub });

    const content = Buffer.from("into a chosen destination");
    const createRes = await createUpload(uploaderSub, content.length, {
      filename: "chosen.txt",
      destinationCollectionId: other.id,
    });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, content);
    expect(patchRes.status).toBe(200);

    const record = await resolveByNames([other.name, "chosen.txt"]);
    expect(record).not.toBeNull();
    expect(record?.collectionId).toBe(other.id);
  });

  it("falls back to the ROOT when destinationCollectionId names a collection the caller cannot write to (D-126)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    const strangerCollection = await createCollection({
      parentId: "",
      name: `stranger-${randomUUID()}`,
      ownerSub: `user:${randomUUID()}`,
    });
    mockAuthorizedAs(uploaderSub);

    const content = Buffer.from("falls back");
    const createRes = await createUpload(uploaderSub, content.length, {
      filename: "fallback.txt",
      destinationCollectionId: strangerCollection.id,
    });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, content);
    expect(patchRes.status).toBe(200);

    expect(await resolveByNames([strangerCollection.name, "fallback.txt"])).toBeNull();
    const record = await resolveByNames(["fallback.txt"]);
    expect(record).not.toBeNull();
    expect(record?.collectionId).toBe("");
  });

  it("protection at ingest comes from the destination collection's default_protection (D-86)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    const privateByDefault = await createCollection({
      parentId: "",
      name: `priv-default-${randomUUID()}`,
      ownerSub: uploaderSub,
    });
    await getPool().query("UPDATE collections SET default_protection = 'private' WHERE id = ?", [privateByDefault.id]);
    mockAuthorizedAs(uploaderSub);

    const content = Buffer.from("private by default");
    const createRes = await createUpload(uploaderSub, content.length, {
      filename: "p.txt",
      destinationCollectionId: privateByDefault.id,
    });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    await patchUpload(uploadUrl, uploaderSub, 0, content);

    const [rows] = await getPool().query("SELECT protection FROM files WHERE collection_id = ? AND name = ?", [
      privateByDefault.id,
      "p.txt",
    ]);
    expect((rows as { protection: string }[])[0]?.protection).toBe("private");
  });

  it("two uploads of the same name into one collection produce two distinct files with distinct ids (D-81/D-85, no on-disk collision)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    async function uploadOnce(content: string): Promise<void> {
      const createRes = await createUpload(uploaderSub, content.length, { filename: "dup.txt" });
      const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
      const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, Buffer.from(content));
      expect(patchRes.status).toBe(200);
    }

    await uploadOnce("first");
    await uploadOnce("second");

    const first = await resolveByNames(["dup.txt"]);
    const second = await resolveByNames(["dup(2).txt"]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
    expect(first!.diskName).not.toBe(second!.diskName);
  });

  it("an uploaded JPEG carrying GPS EXIF has no GPS on disk afterwards (D-60 end to end)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const jpegBytes = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withExif({ IFD3: { GPSLatitude: "1/1 0/1 0/1", GPSLatitudeRef: "N" } })
      .toBuffer();
    const before = await sharp(jpegBytes).metadata();
    expect(before.exif).toBeDefined();

    const createRes = await createUpload(uploaderSub, jpegBytes.length, {
      filename: "photo.jpg",
    });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, jpegBytes);
    expect(patchRes.status).toBe(200);

    const record = await resolveByNames(["photo.jpg"]);
    const after = await sharp(path.join(root, diskRelPath(record!))).metadata();
    expect(after.exif).toBeUndefined();
  });

  it("an uploaded PNG lands with captured width/height (D-74)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const pngBytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 5, g: 6, b: 7 } },
    })
      .png()
      .toBuffer();

    const createRes = await createUpload(uploaderSub, pngBytes.length, { filename: "photo.png" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, pngBytes);
    expect(patchRes.status).toBe(200);

    const record = await resolveByNames(["photo.png"]);
    expect(record?.width).toBe(40);
    expect(record?.height).toBe(30);
  });

  it("a forced stripInPlace failure leaves NO row and NO bytes (D-85)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    // sharp rejects a file with a real image extension but garbage content - stripStrategyFor("bad.png")
    // is "image", so stripInPlace attempts to run sharp on it and fails.
    const garbage = Buffer.from("not actually a png");
    const createRes = await createUpload(uploaderSub, garbage.length, { filename: "bad.png" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, garbage);
    expect(patchRes.status).toBe(422);

    expect(await resolveByNames(["bad.png"])).toBeNull();
    const [rows] = await getPool().query(
      "SELECT COUNT(*) AS n FROM files WHERE collection_id = '' AND owner_sub = ?",
      [uploaderSub],
    );
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });
});
