import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerAvatarRoutes } from "../../src/routes/avatar.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";
import type { Config } from "../../src/config.ts";

const verifyMock = vi.mocked(verify);
const FILES_HOST = "files.mosni.dev";

// D-136: the avatar proxy - GET /api/avatar/<fileId> fetches auth.mosni.dev/avatar/<sub> SERVER-SIDE, so
// the raw sub never reaches the client. Gated like the file whose uploader it names (public/unlisted open,
// secret/private need the same elevated-access check the preview API uses, since this endpoint has no
// token mechanism of its own).
describe("routes/avatar.ts (D-136)", () => {
  let root: string;
  let app: FastifyInstance;
  let config: Config;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "avatar-test-"));
    initFilesStorage(root);

    config = makeTestConfig({ storageRoot: root, authIssuer: "https://auth.mosni.dev" });
    app = Fastify({ logger: false });
    await registerAvatarRoutes(app, config);
    await app.ready();
    vi.stubGlobal("fetch", fetchMock);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }, 30_000);

  afterEach(() => {
    vi.mocked(verify).mockReset();
    fetchMock.mockReset();
  });

  async function seed(opts: {
    protection: Protection;
    collectionProtection?: Protection;
    ownerSub?: string | null;
    uploaderName?: string | null;
  }): Promise<{ fileId: string }> {
    const name = `file-${randomUUID()}.txt`;
    const collection = await createCollection({
      parentId: "",
      name: `c-${randomUUID()}`,
      ownerSub: opts.ownerSub ?? "user:owner",
      protection: opts.collectionProtection,
    });
    const claimed = await claimFileRow({
      collectionId: collection.id,
      name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub ?? "user:owner",
      uploaderSub: opts.ownerSub ?? "user:owner",
      protection: opts.protection,
      uploaderName: opts.uploaderName === undefined ? "Hannah" : opts.uploaderName,
    });
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await commitFileRow(claimed.id, {
      bytes: 7,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
      thumbName: null,
    });
    return { fileId: claimed.id };
  }

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { host: FILES_HOST, ...headers } });

  it("proxies image bytes for a public file's avatar, with no sub anywhere in the response", async () => {
    const { fileId } = await seed({ protection: "public", ownerSub: "user:owner-abc" });
    fetchMock.mockResolvedValue(
      new Response(Buffer.from("fake-avatar-bytes"), { status: 200, headers: { "content-type": "image/png" } }),
    );

    const res = await get(`/api/avatar/${fileId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("fake-avatar-bytes");
    expect(res.headers["content-type"]).toBe("image/png");

    // The raw sub never appears anywhere in the response - headers, body, or (by construction, since this
    // is not a redirect) the URL the client sees.
    expect(JSON.stringify(res.headers)).not.toContain("user:owner-abc");
    expect(res.body).not.toContain("user:owner-abc");

    // And the upstream fetch target proves the proxy never redirects - it is a same-process fetch, the sub
    // reaching only the server-to-server request, never a Location header back to the client.
    expect(fetchMock).toHaveBeenCalledWith("https://auth.mosni.dev/avatar/user%3Aowner-abc");
    expect(res.headers.location).toBeUndefined();
  });

  it("sets a long-lived Cache-Control header", async () => {
    const { fileId } = await seed({ protection: "public" });
    fetchMock.mockResolvedValue(new Response(Buffer.from("x"), { status: 200 }));
    const res = await get(`/api/avatar/${fileId}`);
    expect(res.headers["cache-control"]).toContain("max-age=86400");
  });

  it("404s for an unknown file id", async () => {
    expect((await get(`/api/avatar/${randomUUID()}`)).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when uploaderName is null - never proxies for a file with no captured name", async () => {
    const { fileId } = await seed({ protection: "public", uploaderName: null });
    const res = await get(`/api/avatar/${fileId}`);
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the upstream fetch fails, rather than 500ing", async () => {
    const { fileId } = await seed({ protection: "public" });
    fetchMock.mockRejectedValue(new Error("network error"));
    expect((await get(`/api/avatar/${fileId}`)).statusCode).toBe(404);
  });

  it("404s when the upstream responds non-ok", async () => {
    const { fileId } = await seed({ protection: "public" });
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    expect((await get(`/api/avatar/${fileId}`)).statusCode).toBe(404);
  });

  describe("a PRIVATE file's avatar - a file the viewer cannot see", () => {
    it("404s anonymously", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      expect((await get(`/api/avatar/${fileId}`)).statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("404s for a non-owner, non-granted viewer", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:other", roles: [] } as never);
      expect((await get(`/api/avatar/${fileId}`, { authorization: "Bearer x" })).statusCode).toBe(404);
    });

    it("200s for the owner", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      fetchMock.mockResolvedValue(new Response(Buffer.from("bytes"), { status: 200 }));
      expect((await get(`/api/avatar/${fileId}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("200s for a mosni_owner superuser", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true, roles: [] } as never);
      fetchMock.mockResolvedValue(new Response(Buffer.from("bytes"), { status: 200 }));
      expect((await get(`/api/avatar/${fileId}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("200s for an ACL-granted sub", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [fileId, grantedSub]);
      verifyMock.mockResolvedValue({ sub: grantedSub, roles: [] } as never);
      fetchMock.mockResolvedValue(new Response(Buffer.from("bytes"), { status: 200 }));
      expect((await get(`/api/avatar/${fileId}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });
  });

  it("a collection-gated (effectively private) file's avatar 404s anonymously despite its own stored level being public", async () => {
    const { fileId } = await seed({
      protection: "public",
      collectionProtection: "private",
      ownerSub: "user:owner",
    });
    expect((await get(`/api/avatar/${fileId}`)).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a SECRET file's avatar 404s anonymously - this endpoint has no token mechanism to satisfy it", async () => {
    const { fileId } = await seed({ protection: "secret", ownerSub: "user:owner" });
    expect((await get(`/api/avatar/${fileId}`)).statusCode).toBe(404);
  });

  it("a SECRET file's avatar 200s for its owner via the same elevated-access check private uses", async () => {
    const { fileId } = await seed({ protection: "secret", ownerSub: "user:owner" });
    verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
    fetchMock.mockResolvedValue(new Response(Buffer.from("bytes"), { status: 200 }));
    expect((await get(`/api/avatar/${fileId}`, { authorization: "Bearer x" })).statusCode).toBe(200);
  });
});
