import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerDeliveryRoutes } from "../../src/routes/delivery.ts";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { deleteFileRow, initFilesStorage } from "../../src/storage/files.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const verifyMock = vi.mocked(verify);
const DL_HOST = "dl.mosni.dev";

describe("routes/delivery.ts (E5a - the security-critical route, session 007 URL model)", () => {
  let root: string;
  let app: FastifyInstance;
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
    root = await mkdtemp(path.join(os.tmpdir(), "delivery-test-"));
    initFilesStorage(root);

    app = Fastify({ logger: false });
    await registerDeliveryRoutes(app, makeTestConfig({ storageRoot: root }));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    vi.mocked(verify).mockReset();
    while (createdPaths.length > 0) await deleteFileRow(createdPaths.pop()!);
  });

  async function seed(opts: {
    relPath?: string;
    protection: Protection;
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
      "INSERT INTO files (path, bytes, protection, link_token, owner_sub, uploader_sub) VALUES (?, ?, ?, ?, ?, NULL)",
      [relPath, content.length, opts.protection, linkToken, opts.ownerSub ?? null],
    );
    return { relPath, linkToken };
  }

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { host: DL_HOST, ...headers } });

  describe("plain-path delivery (/<relpath>)", () => {
    it("serves public and unlisted via X-Accel-Redirect with an empty body and the security headers", async () => {
      for (const protection of ["public", "unlisted"] as const) {
        const { relPath } = await seed({ protection });
        const res = await get(`/${relPath}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(""); // Node never streams bytes (D-5)
        expect(res.headers["x-accel-redirect"]).toBe(`/internal-storage/${relPath}`);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
      }
    });

    it("serves an arbitrarily nested path (P6 deep nesting)", async () => {
      const relPath = `d-${randomUUID()}/a/b/c.png`;
      await seed({ relPath, protection: "public" });
      const res = await get(`/${relPath}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-accel-redirect"]).toBe(`/internal-storage/${relPath}`);
    });

    it("returns 404 (not 403) for a secret file at its readable path (D-59 mandatory)", async () => {
      const { relPath } = await seed({ protection: "secret" });
      expect((await get(`/${relPath}`)).statusCode).toBe(404);
    });

    it("sends Content-Disposition: attachment for a non-allowlisted extension", async () => {
      const { relPath } = await seed({ relPath: `z-${randomUUID()}/a.zip`, protection: "public" });
      expect((await get(`/${relPath}`)).headers["content-disposition"]).toContain("attachment");
    });

    it("returns 404 for a path with no row", async () => {
      expect((await get(`/${randomUUID()}/nope.txt`)).statusCode).toBe(404);
    });

    // The URLs handed to users are percent-encoded per segment (buildFileUrls), so a name with a space or
    // a non-ASCII character only works if the router hands the handler the DECODED path. Every other test
    // here uses plain ASCII names and would miss a regression in that.
    it("resolves a percent-encoded name (space and non-ASCII) back to the stored path", async () => {
      const folder = `enc-${randomUUID()}`;
      const name = "a b ü.png";
      const relPath = `${folder}/${name}`;
      await seed({ relPath, protection: "public" });

      const encoded = `/${folder}/${encodeURIComponent(name)}`;
      const res = await get(encoded);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-accel-redirect"]).toBe(
        `/internal-storage/${folder}/${encodeURIComponent(name)}`,
      );
      expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''");
    });
  });

  describe("token delivery (/t/:token)", () => {
    it("serves a secret file by token even though its readable path 404s", async () => {
      const { relPath, linkToken } = await seed({ protection: "secret" });
      const res = await get(`/t/${linkToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-accel-redirect"]).toBe(`/internal-storage/${relPath}`);
    });

    it("404s an unknown token", async () => {
      expect((await get("/t/ZZZZZ")).statusCode).toBe(404);
    });
  });

  describe("private (security invariant 6 - byte-for-byte sub matching)", () => {
    it("401s with no token, 403s a wrong sub, 200s the owner", async () => {
      const { relPath } = await seed({ protection: "private", ownerSub: "user:owner" });
      expect((await get(`/${relPath}`)).statusCode).toBe(401);

      verifyMock.mockResolvedValue({ sub: "user:other", roles: [] } as never);
      expect((await get(`/${relPath}`, { authorization: "Bearer x" })).statusCode).toBe(403);

      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      expect((await get(`/${relPath}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("200s for a mosni_owner superuser regardless of ownership (files:admin dropped)", async () => {
      const { relPath } = await seed({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true, roles: [] } as never);
      expect((await get(`/${relPath}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("grants an exact ACL sub and refuses a one-character-off near-miss", async () => {
      const { relPath } = await seed({ protection: "private", ownerSub: "user:owner" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO file_acl (path, sub) VALUES (?, ?)", [relPath, grantedSub]);

      verifyMock.mockResolvedValue({ sub: grantedSub, roles: [] } as never);
      expect((await get(`/${relPath}`, { authorization: "Bearer x" })).statusCode).toBe(200);

      verifyMock.mockResolvedValue({ sub: grantedSub.slice(0, -1), roles: [] } as never);
      expect((await get(`/${relPath}`, { authorization: "Bearer x" })).statusCode).toBe(403);
    });
  });
});
