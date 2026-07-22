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
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { initFilesStorage, resolveByPath } from "../../src/storage/files.ts";

const verifyMock = vi.mocked(verify);

describe("routes/upload.ts - tus upload (D1-D3)", () => {
  let root: string;
  let app: FastifyInstance;
  let redis: Redis;
  let config: Config;
  const createdFolders: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applySchema();

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
    while (createdFolders.length > 0) {
      const folder = createdFolders.pop()!;
      // Files are path-keyed now (no collections table) - clean up everything under the uploader's folder.
      await getPool().query("DELETE FROM file_acl WHERE path LIKE ?", [`${folder}/%`]);
      await getPool().query("DELETE FROM files WHERE path LIKE ?", [`${folder}/%`]);
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
  //
  // The connection ALWAYS goes to this suite's own listener; only the path is taken from `url`. tus
  // builds its Location header from the request's Host, which is now `files.mosni.dev`, so following it
  // literally would send the test out to the real internet - exactly the escape the D-70 e2e run hit
  // with dl.mosni.dev. Splitting "where to connect" from "what Host to claim" is what nginx does in
  // production anyway.
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

  function mockAuthorizedAs(sub: string): void {
    verifyMock.mockResolvedValue({ sub, roles: ["files:write"] } as never);
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
    // OPTIONS requests need no auth (tus capability discovery) and hit no filesystem/DB, so this stays
    // cheap while still exercising the same encapsulated Fastify scope every other tus request goes
    // through. More than the global 100/min limit, well under the dedicated 600/min one.
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

  it("completes the full tus lifecycle (create -> offset -> resume -> completion) and returns preview/direct URLs", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    mockAuthorizedAs(uploaderSub);
    // The default collection this upload lands in is named from the sub (no preferred name given) -
    // track it for cleanup.
    createdFolders.push(uploaderSub);

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
    // unlisted (the default) resolves at the readable /f/<path> preview and plain dl path, not a token.
    expect(body.previewUrl).toContain("files.mosni.dev/f/");
    expect(body.directUrl).toContain("dl.mosni.dev/");
    expect(body.previewUrl).toContain(encodeURIComponent(uploaderSub));
    expect(body.previewUrl).toContain("greeting.txt");

    const writtenPath = path.join(root, uploaderSub, "greeting.txt");
    expect((await readFile(writtenPath)).toString()).toBe(content.toString());
  });

  it("rejects a traversal-shaped filename and leaves nothing on disk", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdFolders.push(uploaderSub);
    mockAuthorizedAs(uploaderSub);

    const content = Buffer.from("malicious");
    const createRes = await createUpload(uploaderSub, content.length, {
      filename: "../../../etc/passwd",
    });
    expect(createRes.status).toBe(201);
    const uploadUrl = new URL(createRes.headers.get("location")!, baseUrl()).toString();

    const patchRes = await patchUpload(uploadUrl, uploaderSub, 0, content);
    expect(patchRes.status).toBe(400);

    const collectionDir = path.join(root, uploaderSub);
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(collectionDir).catch(() => []),
    );
    expect(entries.filter((e) => !e.startsWith("."))).toHaveLength(0);
  });

  it("an uploaded JPEG carrying GPS EXIF has no GPS on disk afterwards (D-60 end to end)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdFolders.push(uploaderSub);
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

    const writtenPath = path.join(root, uploaderSub, "photo.jpg");
    const after = await sharp(writtenPath).metadata();
    expect(after.exif).toBeUndefined();
  });

  it("an uploaded PNG lands with captured width/height (D-74)", async () => {
    const uploaderSub = `user:${randomUUID()}`;
    createdFolders.push(uploaderSub);
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

    const record = await resolveByPath(`${uploaderSub}/photo.png`);
    expect(record?.width).toBe(40);
    expect(record?.height).toBe(30);
  });
});
