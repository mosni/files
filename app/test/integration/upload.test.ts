import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import rateLimit from "@fastify/rate-limit";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

// auth.mosni.dev is not reachable from this sandbox - there is no live IdP to test against here (unlike
// MariaDB/redis, which are real Docker services this suite already depends on). Mocking verify() is the
// only way to exercise the route's authorized paths at all; unauthorized paths (missing/garbage token)
// need no mock and are covered separately below.
vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerUploadRoutes } from "../../src/routes/upload.ts";
import { UPLOAD_EXPIRY_MS } from "../../src/lib/uploadConfig.ts";
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
      // Explicitly ON: this file asserts the tus limiter's real 429 behaviour, and review 060's
      // RATE_LIMIT_DISABLED is an e2e-tier flag that must never quietly apply here.
      rateLimitDisabled: false,
    };

    app = Fastify({ logger: false });
    // The GLOBAL limiter is registered first, exactly as server.ts does it. This is load-bearing for the
    // isolation test below: without it that test ran against a server with no global limiter at all, so
    // it could not have failed however broken the isolation was (found by the E6 review session, 042).
    await app.register(rateLimit, {
      redis,
      global: true,
      max: 100,
      timeWindow: "1 minute",
      nameSpace: "fastify-rate-limit-global-",
    });
    await registerUploadRoutes(app, config);
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

  it("is not throttled by the global 100/min rate limit (D1's dedicated 600/min budget)", async () => {
    // A unique bearer per run so the upload namespace's own counter starts clean; the requests all come
    // from this container's single IP, which is exactly the client the global limiter would have capped.
    const bearer = `Bearer rl-probe-${Date.now()}`;
    const responses = await Promise.all(
      Array.from({ length: 105 }, () =>
        request(`${baseUrl()}/api/upload`, {
          method: "OPTIONS",
          headers: { "Tus-Resumable": "1.0.0", Authorization: bearer },
        }),
      ),
    );
    expect(responses.every((res) => res.status !== 429)).toBe(true);
  });

  // E6 A1 (D-174) / AC7: FileStore is constructed with expirationPeriodInMilliseconds, which is what makes
  // @tus/server 410 an expired HEAD (dist/handlers/HeadHandler.js compares now against creation_date +
  // getExpiration()). Nothing exercised that option before this test (added by the review session, 042);
  // it is one constructor argument away from being silently absent, and the whole D-174 window rests on it.
  // Ageing the sidecar's own creation_date is how the expiry is reached without waiting seven days or
  // faking the clock for every other test in this file.
  it("410s a HEAD for a partial upload older than the expiry window (D-174)", async () => {
    verifyMock.mockResolvedValue({ sub: "user:expiry", roles: ["files:write"] } as never);
    const created = await createUpload("t", 1024, { filename: `expired-${randomUUID().slice(0, 8)}.bin` });
    expect(created.status).toBe(201);
    const uploadUrl = new URL(created.headers.get("location")!, baseUrl()).toString();
    const uploadId = uploadUrl.split("/").pop()!;

    const fresh = await request(uploadUrl, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", Authorization: "Bearer t" },
    });
    expect(fresh.status, "a fresh partial upload is resumable").toBe(200);

    const sidecarPath = path.join(config.tusTempDir, `${uploadId}.json`);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { creation_date: string };
    sidecar.creation_date = new Date(Date.now() - UPLOAD_EXPIRY_MS - 60_000).toISOString();
    await writeFile(sidecarPath, JSON.stringify(sidecar));

    const expired = await request(uploadUrl, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", Authorization: "Bearer t" },
    });
    expect(expired.status).toBe(410);
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

  // E7-QA1 §A2.4/D-196: a grant-only caller (no files:write, only a can_upload=1 ACL row) can now reach
  // the upload pipeline at all (A2.1) and complete an upload into the collection they were granted on.
  describe("a grant-only caller (D-196: no files:write, only a can_upload ACL row)", () => {
    it("uploads into the granted collection", async () => {
      const ownerSub = `user:${randomUUID()}`;
      const grantedSub = `user:${randomUUID()}`;
      createdOwnerSubs.push(ownerSub, grantedSub);
      const granted = await createCollection({ parentId: "", name: `grant-${randomUUID()}`, ownerSub });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        granted.id,
        grantedSub,
      ]);
      mockAuthorizedAs(grantedSub, { roles: [] }); // D-191's invite shape: files:read only, no files:write

      const content = Buffer.from("uploaded via an invite's upload grant");
      const createRes = await createUpload(grantedSub, content.length, {
        filename: "invited.txt",
        destinationCollectionId: granted.id,
      });
      expect(createRes.status).toBe(201);
      const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
      const patchRes = await patchUpload(uploadUrl, grantedSub, 0, content);
      expect(patchRes.status).toBe(200);

      const record = await resolveByNames([granted.name, "invited.txt"]);
      expect(record).not.toBeNull();
      expect(record?.collectionId).toBe(granted.id);
    });

    // A2.3's landmine: under D-196 the OLD root-fallback rule would have let a grant-only caller drop
    // files at the root just by sending a bogus destinationCollectionId - the hard 403 below is what
    // closes that.
    it("sending a bogus destination gets 403, NOT a root upload", async () => {
      const grantedSub = `user:${randomUUID()}`;
      createdOwnerSubs.push(grantedSub);
      const elsewhere = await createCollection({ parentId: "", name: `elsewhere-${randomUUID()}`, ownerSub: `user:${randomUUID()}` });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        elsewhere.id,
        grantedSub,
      ]);
      mockAuthorizedAs(grantedSub, { roles: [] });

      const content = Buffer.from("should never land anywhere");
      const createRes = await createUpload(grantedSub, content.length, {
        filename: "bogus-dest.txt",
        destinationCollectionId: randomUUID(), // resolves to nothing
      });
      expect(createRes.status).toBe(201); // tus create itself always succeeds - the destination is only resolved on finish
      const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
      const patchRes = await patchUpload(uploadUrl, grantedSub, 0, content);
      expect(patchRes.status).toBe(403);

      expect(await resolveByNames(["bogus-dest.txt"])).toBeNull(); // did NOT land at the root
    });

    it("sending NO destination at all gets 403 too (the same landmine, absent-metadata shape)", async () => {
      const grantedSub = `user:${randomUUID()}`;
      createdOwnerSubs.push(grantedSub);
      const elsewhere = await createCollection({ parentId: "", name: `elsewhere2-${randomUUID()}`, ownerSub: `user:${randomUUID()}` });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        elsewhere.id,
        grantedSub,
      ]);
      mockAuthorizedAs(grantedSub, { roles: [] });

      const content = Buffer.from("no destination given");
      const createRes = await createUpload(grantedSub, content.length, { filename: "no-dest.txt" });
      const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
      const patchRes = await patchUpload(uploadUrl, grantedSub, 0, content);
      expect(patchRes.status).toBe(403);

      expect(await resolveByNames(["no-dest.txt"])).toBeNull();
    });
  });

  it("a caller with no upload grant anywhere gets 403 at onIncomingRequest, before any destination is even asked about", async () => {
    verifyMock.mockResolvedValue({ sub: `user:${randomUUID()}`, roles: [] } as never);
    const res = await createUpload("t", 5, { filename: "no-grant.txt" });
    expect(res.status).toBe(403);
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

  // C2 (E5.1 Wave C, D-154): the uploader's captured name, from the JWT's `name` claim. C3 (the owner
  // flag) is GONE - D-168 (E5.1 live-testing round 4) replaced it with a provider-based fallback; see
  // app/test/unit/previewContext.test.ts's "uploaderName fallback (D-168)" block for that coverage now.
  it("captures uploaderName from the name claim (C2)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub, { name: "Hannah Test" });

    const content = Buffer.from("named uploader content");
    const createRes = await createUpload(uploaderSub, content.length, { filename: "named.txt" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, content);
    expect(patchRes.status).toBe(200);

    const record = await resolveByNames(["named.txt"]);
    expect(record?.uploaderName).toBe("Hannah Test");
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

    // D-143: classification is content-based, so this must be a file ffprobe genuinely detects as a video
    // (a real video stream) but whose probed container has no entry in strip.ts's muxer map - a real
    // detected-but-unstrippable file, not garbage bytes wearing a misleading extension (which is no longer
    // distinguishable from "not a photo or video at all" - see the test below).
    //
    // This used to be a `.avi`. That stopped being unstrippable on 2026-08-06: rejecting an ordinary video
    // outright was a live defect, so avi/asf/flv/mpegts/ogg joined the muxer map and now strip fine. NUT is
    // ffmpeg's own container, muxable here and deliberately NOT mapped, so the fail-closed path still has a
    // real fixture. (That this test FAILED on .avi when the map changed is the fix working end to end.)
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "upload-nut-fixture-"));
    const nutPath = path.join(fixtureDir, "legacy.nut");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=32x32:rate=25",
      "-c:v", "mpeg4", "-metadata", "comment=secret", "-f", "nut", nutPath,
    ]);
    const nutBytes = await readFile(nutPath);
    await rm(fixtureDir, { recursive: true, force: true });

    const createRes = await createUpload(uploaderSub, nutBytes.length, { filename: "legacy.nut" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, nutBytes);
    expect(patchRes.status).toBe(422);

    expect(await resolveByNames(["legacy.nut"])).toBeNull();
    const [rows] = await getPool().query(
      "SELECT COUNT(*) AS n FROM files WHERE collection_id = '' AND owner_sub = ?",
      [uploaderSub],
    );
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("a genuinely non-media file uploads normally even with a misleading image extension (D-143 - AC19c)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    // Under the OLD extension-based design this would have been classified "image" by name alone and
    // rejected as an unstrippable one (422). Content-based classification correctly puts it in the same
    // "unknown, out of scope" bucket as a .zip or .pdf - the extension never decides, in either direction.
    const notAnImage = Buffer.from("just some bytes, not a real image");
    const createRes = await createUpload(uploaderSub, notAnImage.length, { filename: "not-really.png" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, notAnImage);
    expect(patchRes.status).toBe(200);

    const record = await resolveByNames(["not-really.png"]);
    expect(record).not.toBeNull();
  });

  it("a non-media file (.zip) uploads successfully and is stored as-is - out of scope for invariant 5 (AC19c)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdOwnerSubs.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]); // a minimal local-file-header
    const createRes = await createUpload(uploaderSub, zipBytes.length, { filename: "archive.zip" });
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();
    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, zipBytes);
    expect(patchRes.status).toBe(200);

    const record = await resolveByNames(["archive.zip"]);
    expect(record).not.toBeNull();
    const onDisk = await readFile(path.join(root, diskRelPath(record!)));
    expect(onDisk).toEqual(zipBytes);
  });
});
