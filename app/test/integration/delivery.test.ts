import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerDeliveryRoutes } from "../../src/routes/delivery.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { signDelivery } from "../../src/lib/deliverySignature.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";
import type { Config } from "../../src/config.ts";

const verifyMock = vi.mocked(verify);
const DL_HOST = "dl.mosni.dev";

describe("routes/delivery.ts (D-81/D-84/D-90: resolved through the database, signed URLs, own Content-Type)", () => {
  let root: string;
  let app: FastifyInstance;
  let config: Config;

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "delivery-test-"));
    initFilesStorage(root);

    config = makeTestConfig({ storageRoot: root, deliverySigningSecret: "delivery-test-secret" });
    app = Fastify({ logger: false });
    await registerDeliveryRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    vi.mocked(verify).mockReset();
  });

  async function seed(opts: {
    name?: string;
    protection: Protection;
    collectionProtection?: Protection;
    ownerSub?: string | null;
    content?: string;
  }): Promise<{
    collectionId: string;
    collectionName: string;
    name: string;
    linkToken: string;
    fileId: string;
  }> {
    const name = opts.name ?? `file-${randomUUID()}.txt`;
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
      ownerSub: opts.ownerSub ?? "user:no-owner-placeholder",
      uploaderSub: opts.ownerSub ?? "user:owner",
      protection: opts.protection,
    });
    const content = opts.content ?? "content";
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    await commitFileRow(claimed.id, {
      bytes: content.length,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
    });
    return {
      collectionId: collection.id,
      collectionName: collection.name,
      name,
      linkToken: claimed.linkToken,
      fileId: claimed.id,
    };
  }

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { host: DL_HOST, ...headers } });

  describe("plain-path delivery (/<collection>/.../<name>)", () => {
    it("serves public and unlisted via X-Accel-Redirect with an empty body and the security headers", async () => {
      for (const protection of ["public", "unlisted"] as const) {
        const { collectionName, name } = await seed({ protection });
        const res = await get(`/${collectionName}/${name}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(""); // Node never streams bytes (D-5)
        expect(res.headers["x-accel-redirect"]).toMatch(/^\/internal-storage\/2026\/07\/.+/);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
      }
    });

    it("D-90: sets Content-Type from the DISPLAY name, not the on-disk name", async () => {
      const { collectionName } = await seed({ name: "report.txt", protection: "public" });
      // Rename only the DB row (a pure UPDATE, D-82) - the disk name still ends in the OLD extension.
      const renamed = await getPool().query("SELECT id FROM files WHERE name = ?", ["report.txt"]);
      const fileId = (renamed[0] as { id: string }[])[0]!.id;
      await getPool().query("UPDATE files SET name = ? WHERE id = ?", ["report.md", fileId]);

      const res = await get(`/${collectionName}/report.md`);
      expect(res.statusCode).toBe(200);
      // .md is not on the inline allowlist, so it downloads - but Content-Type must still reflect the
      // CURRENT (renamed) display name, not the pinned-forever disk name's original .txt extension.
      expect(res.headers["content-type"]).not.toContain("text/plain");
    });

    it("D-90: a still-.txt display name gets text/plain Content-Type", async () => {
      const { collectionName } = await seed({ name: "notes.txt", protection: "public" });
      const res = await get(`/${collectionName}/notes.txt`);
      expect(res.headers["content-type"]).toContain("text/plain");
    });

    it("returns 404 (not 403) for a secret file at its readable path (D-59 mandatory)", async () => {
      const { collectionName, name } = await seed({ protection: "secret" });
      expect((await get(`/${collectionName}/${name}`)).statusCode).toBe(404);
    });

    it("sends Content-Disposition: attachment for a non-allowlisted extension", async () => {
      const { collectionName, name } = await seed({ name: "a.zip", protection: "public" });
      expect((await get(`/${collectionName}/${name}`)).headers["content-disposition"]).toContain("attachment");
    });

    it("returns 404 for a path with no row", async () => {
      expect((await get(`/${randomUUID()}/nope.txt`)).statusCode).toBe(404);
    });

    it("resolves a percent-encoded name (space and non-ASCII)", async () => {
      const name = "a b ü.png";
      const { collectionName } = await seed({ name, protection: "public" });
      const encoded = `/${collectionName}/${encodeURIComponent(name)}`;
      const res = await get(encoded);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''");
    });
  });

  describe("token delivery (/t/:token)", () => {
    it("serves a secret file by token even though its readable path 404s", async () => {
      const { linkToken } = await seed({ protection: "secret" });
      const res = await get(`/t/${linkToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-accel-redirect"]).toMatch(/^\/internal-storage\//);
    });

    it("404s an unknown token", async () => {
      expect((await get("/t/ZZZZZ")).statusCode).toBe(404);
    });
  });

  describe("private (security invariant 6 - byte-for-byte sub matching)", () => {
    it("401s with no token, 403s a wrong sub, 200s the owner", async () => {
      const { collectionName, name } = await seed({ protection: "private", ownerSub: "user:owner" });
      expect((await get(`/${collectionName}/${name}`)).statusCode).toBe(401);

      verifyMock.mockResolvedValue({ sub: "user:other", roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(403);

      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("200s for a mosni_owner superuser regardless of ownership (files:admin dropped)", async () => {
      const { collectionName, name } = await seed({ protection: "private", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true, roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("grants an exact ACL sub and refuses a one-character-off near-miss", async () => {
      const { collectionName, name, fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [fileId, grantedSub]);

      verifyMock.mockResolvedValue({ sub: grantedSub, roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(200);

      verifyMock.mockResolvedValue({ sub: grantedSub.slice(0, -1), roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(403);
    });
  });

  // D-96: the landmine. A row's STORED protection can legitimately be looser than its collection's - every
  // read path must act on the EFFECTIVE level, never the column.
  describe("effective protection (D-96) - a collection's protection gates its files too", () => {
    it("a public file inside a secret collection 404s unconditionally at its readable dl. path, but its own /t/<token> still delivers with no auth needed", async () => {
      // secret is the one level that 404s at a readable path REGARDLESS of identity (D-59/D-99) - private
      // still resolves there, gated on auth (covered separately below).
      const { collectionName, name, linkToken } = await seed({
        protection: "public",
        collectionProtection: "secret",
      });
      expect((await get(`/${collectionName}/${name}`)).statusCode).toBe(404);

      const tokenRes = await get(`/t/${linkToken}`);
      expect(tokenRes.statusCode).toBe(200);
      expect(tokenRes.headers["x-accel-redirect"]).toMatch(/^\/internal-storage\//);
    });

    it("a public file inside a private collection resolves at its readable path but requires auth (401 anonymous, 200 owner)", async () => {
      // D-99: private still resolves in principle at the readable path; it is gated by identity, not
      // hidden outright like secret is.
      const { collectionName, name } = await seed({
        protection: "public",
        collectionProtection: "private",
        ownerSub: "user:owner",
      });
      expect((await get(`/${collectionName}/${name}`)).statusCode).toBe(401);

      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("an unlisted file inside a public collection stays gated at unlisted (own level is the floor, not the ceiling)", async () => {
      // D-97's floor only stops a LOOSER value from being SET; a file already stored looser than its
      // collection is untouched, and the effective level is still the file's own here since 'unlisted' is
      // MORE restrictive than the collection's 'public'.
      const { collectionName, name } = await seed({ protection: "unlisted", collectionProtection: "public" });
      const res = await get(`/${collectionName}/${name}`);
      expect(res.statusCode).toBe(200); // unlisted still resolves at its readable path (only secret doesn't)
    });

    it("a private file's own private branch is triggered by the EFFECTIVE level, not just its own stored column", async () => {
      // The file itself is stored 'unlisted'; its collection is 'private' - the private-authorization
      // branch must still fire, or a collection-gated file would leak with no auth check at all.
      const { collectionName, name } = await seed({
        protection: "unlisted",
        collectionProtection: "private",
        ownerSub: "user:owner",
      });
      expect((await get(`/${collectionName}/${name}`)).statusCode).toBe(401);

      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });
  });

  // D-99: authorized identity for `private` includes a grant on ANY ancestor collection, not only the
  // file's own file_acl row.
  describe("authorization identity (D-99) - a grant on an ancestor collection reaches into it", () => {
    it("a grantee on the collection reaches a private file inside a private collection", async () => {
      const { collectionId, collectionName, name } = await seed({
        protection: "private",
        collectionProtection: "private",
        ownerSub: "user:owner",
      });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collectionId,
        grantedSub,
      ]);

      verifyMock.mockResolvedValue({ sub: grantedSub, roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(200);
    });

    it("a non-grantee gets 401 with no token, then 403 once authenticated", async () => {
      const { collectionName, name } = await seed({
        protection: "private",
        collectionProtection: "private",
        ownerSub: "user:owner",
      });
      expect((await get(`/${collectionName}/${name}`)).statusCode).toBe(401);

      verifyMock.mockResolvedValue({ sub: `user:${randomUUID()}`, roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(403);
    });

    // AC7 in full: `secret` at a readable path is 404 for EVERYONE - anonymous, grantee, owner and
    // superuser alike (D-99: readablePathResolves returns false before any identity check runs). The
    // anonymous and grantee cases are covered above and below; these are the two the AC names that a
    // reasonable implementation could get wrong by adding an owner bypass, so they get their own assertion
    // rather than resting on the structure happening to be right today.
    it("the OWNER still 404s on their own secret file's readable path", async () => {
      const { collectionName, name } = await seed({ protection: "secret", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:owner", roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(404);
    });

    it("a mosni_owner SUPERUSER still 404s on a secret file's readable path", async () => {
      const { collectionName, name } = await seed({ protection: "secret", ownerSub: "user:owner" });
      verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(404);
    });

    it("a grantee still 404s on a secret file's readable path - secret never consults identity", async () => {
      const { collectionId, collectionName, name } = await seed({
        protection: "secret",
        ownerSub: "user:owner",
      });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collectionId,
        grantedSub,
      ]);
      verifyMock.mockResolvedValue({ sub: grantedSub, roles: [] } as never);
      expect((await get(`/${collectionName}/${name}`, { authorization: "Bearer x" })).statusCode).toBe(404);
    });
  });

  describe("signed delivery (/s/:id) - D-84", () => {
    it("serves a private file's bytes given a valid, unexpired signature - no Bearer needed", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = signDelivery(config.deliverySigningSecret, fileId, exp);

      const res = await get(`/s/${fileId}?exp=${exp}&sig=${sig}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("");
      expect(res.headers["x-accel-redirect"]).toMatch(/^\/internal-storage\//);
    });

    it("404s an expired signature", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      const exp = Math.floor(Date.now() / 1000) - 10;
      const sig = signDelivery(config.deliverySigningSecret, fileId, exp);
      expect((await get(`/s/${fileId}?exp=${exp}&sig=${sig}`)).statusCode).toBe(404);
    });

    it("404s a tampered signature", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = signDelivery(config.deliverySigningSecret, fileId, exp);
      const tampered = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
      expect((await get(`/s/${fileId}?exp=${exp}&sig=${tampered}`)).statusCode).toBe(404);
    });

    it("404s a signature for a DIFFERENT file id", async () => {
      const { fileId: fileA } = await seed({ protection: "private", ownerSub: "user:owner" });
      const { fileId: fileB } = await seed({ protection: "private", ownerSub: "user:owner" });
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sigForA = signDelivery(config.deliverySigningSecret, fileA, exp);
      expect((await get(`/s/${fileB}?exp=${exp}&sig=${sigForA}`)).statusCode).toBe(404);
    });

    it("404s with missing exp/sig query params", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      expect((await get(`/s/${fileId}`)).statusCode).toBe(404);
    });

    it("sets no cookie and reads no Authorization header at all (D-33)", async () => {
      const { fileId } = await seed({ protection: "private", ownerSub: "user:owner" });
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = signDelivery(config.deliverySigningSecret, fileId, exp);
      const res = await get(`/s/${fileId}?exp=${exp}&sig=${sig}`, { authorization: "Bearer garbage-never-checked" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  });
});
