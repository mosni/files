// E8 Wave C5: the admin API (D-217 … D-221). Modelled on app/test/integration/share.test.ts.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));
vi.mock("../../src/auth/internalApi.ts", () => ({ setAccountRole: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { setAccountRole } from "../../src/auth/internalApi.ts";
import { registerAdminRoutes } from "../../src/routes/admin.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, grantFileAcl, hasAclGrant, initFilesStorage, resolveById } from "../../src/storage/files.ts";
import { createCollection, grantCollectionAcl, hasCollectionAclGrant } from "../../src/storage/collections.ts";
import { initSpaShell } from "../../src/storage/spaShell.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const verifyMock = vi.mocked(verify);
const setAccountRoleMock = vi.mocked(setAccountRole);
const FILES_HOST = "files.mosni.dev";

describe("routes/admin.ts + controllers/admin.ts (E8)", () => {
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "admin-test-"));
    initFilesStorage(root);
    // getSpaShell() (GET /admin's handler) throws unless initSpaShell() has run at least once - falls back
    // to a minimal built-in shell for a path with no real web/dist, exactly like server.ts's own tolerance.
    initSpaShell(root);

    app = Fastify({ logger: false });
    const config = makeTestConfig({ storageRoot: root });
    await registerAdminRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  const createdCollectionIds: string[] = [];
  const createdRootFileIds: string[] = [];

  beforeEach(() => {
    setAccountRoleMock.mockResolvedValue({ ok: true, value: undefined });
  });

  afterEach(async () => {
    verifyMock.mockReset();
    setAccountRoleMock.mockReset();
    while (createdRootFileIds.length > 0) {
      const id = createdRootFileIds.pop()!;
      await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [id]);
      await getPool().query("DELETE FROM files WHERE id = ?", [id]);
    }
    while (createdCollectionIds.length > 0) {
      const id = createdCollectionIds.pop()!;
      const [fileRows] = await getPool().query("SELECT id FROM files WHERE collection_id = ?", [id]);
      for (const row of fileRows as { id: string }[]) {
        await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [row.id]);
        await getPool().query("DELETE FROM files WHERE id = ?", [row.id]);
      }
      await getPool().query("DELETE FROM collection_acl WHERE collection_id = ?", [id]);
      await getPool().query("DELETE FROM collections WHERE id = ?", [id]);
    }
  });

  function asUser(sub: string, extra: Record<string, unknown> = {}): void {
    verifyMock.mockResolvedValue({ sub, ...extra } as never);
  }

  const req = (method: "GET" | "POST", url: string, opts: { token?: string; body?: Record<string, unknown> } = {}) =>
    app.inject({
      method,
      url,
      headers: {
        host: FILES_HOST,
        ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      payload: opts.body,
    });

  async function seedCollection(ownerSub: string, opts: { protection?: Protection; name?: string } = {}) {
    const collection = await createCollection({
      parentId: "",
      name: opts.name ?? `c-${randomUUID()}`,
      ownerSub,
      protection: opts.protection,
    });
    createdCollectionIds.push(collection.id);
    return collection;
  }

  async function seedFile(opts: { collectionId?: string; name?: string; ownerSub?: string; protection?: Protection; bytes?: number }) {
    const collectionId = opts.collectionId ?? "";
    const name = opts.name ?? `file-${randomUUID()}.txt`;
    const claimed = await claimFileRow({
      collectionId,
      name,
      diskDir: "2026/08",
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub ?? "user:owner",
      uploaderSub: opts.ownerSub ?? "user:owner",
      protection: opts.protection ?? "private",
      uploaderName: null,
    });
    if (collectionId === "") createdRootFileIds.push(claimed.id);
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "admin-test-bytes");
    await commitFileRow(claimed.id, {
      bytes: opts.bytes ?? 17,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
      thumbName: null,
      isText: false,
    });
    return claimed;
  }

  // C5: the gate, per endpoint - no bearer -> 401; files:read-only -> 404; files:write-only -> 404;
  // both roles -> 200; mosni_owner alone -> 200. D-217: 404, NEVER 403, for an authenticated non-admin -
  // asserted explicitly (a future "correction" back to 403 fails here).
  describe.each([
    ["GET /api/admin/grants", (token?: string) => req("GET", "/api/admin/grants", { token })],
    [
      "POST /api/admin/grants/revoke",
      (token?: string) => req("POST", "/api/admin/grants/revoke", { token, body: { targetType: "file", targetId: "x", sub: "y" } }),
    ],
    ["GET /api/admin/usage", (token?: string) => req("GET", "/api/admin/usage", { token })],
  ] as const)("%s gate (D-68/D-217)", (_label, call) => {
    it("401s with no bearer at all", async () => {
      // No token passed at all - requireClaims never even reaches verify() (no `authorization` header).
      const res = await call(undefined);
      expect(res.statusCode).toBe(401);
    });

    it("404s (never 403) for files:read only - not an admin", async () => {
      asUser("user:reader", { roles: ["files:read"] });
      const res = await call("t");
      expect(res.statusCode).toBe(404);
      expect(res.statusCode).not.toBe(403);
    });

    it("404s (never 403) for files:write only - not an admin", async () => {
      asUser("user:writer", { roles: ["files:write"] });
      const res = await call("t");
      expect(res.statusCode).toBe(404);
      expect(res.statusCode).not.toBe(403);
    });

    it("200s for both files:write and files:delete (D-68's isFilesAdmin)", async () => {
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await call("t");
      expect(res.statusCode).toBe(200);
    });

    it("200s for mosni_owner alone - no second superuser branch needed", async () => {
      asUser("user:superuser", { roles: [], mosni_owner: true });
      const res = await call("t");
      expect(res.statusCode).toBe(200);
    });
  });

  // Review session 059: the gate must run BEFORE Fastify parses and schema-validates the body, or the
  // schema answers first and D-217 is bypassed by simply sending a bad body. Measured with the gate in the
  // handler: an anonymous caller AND an authenticated non-admin both got
  // `400 {"code":"FST_ERR_VALIDATION","message":"body must have required property 'targetType'"}` from
  // POST /api/admin/grants/revoke, while a genuinely non-existent /api/admin/* route answered 404 - so the
  // route and its exact body schema were discoverable by anyone. Every gate test above sends a WELL-FORMED
  // body, which is precisely why none of them could see it.
  describe("the gate runs before body validation (D-217, review 059)", () => {
    it("a non-admin sending a MALFORMED body still gets 404, never a schema error", async () => {
      asUser("user:writer", { roles: ["files:write"] });
      const res = await req("POST", "/api/admin/grants/revoke", { token: "t", body: {} });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("targetType");
    });

    it("an anonymous caller sending a MALFORMED body still gets 401, never a schema error", async () => {
      const res = await req("POST", "/api/admin/grants/revoke", { body: {} });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("targetType");
    });

    it("a non-admin sending NO body at all still gets 404 - body parsing runs after onRequest too", async () => {
      asUser("user:writer", { roles: ["files:write"] });
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/grants/revoke",
        headers: { host: FILES_HOST, authorization: "Bearer t", "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(404);
    });

    // The admin path still reaches the schema, so a genuinely bad body from a genuine admin is still a 400.
    it("an ADMIN sending a malformed body gets the schema's 400", async () => {
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("POST", "/api/admin/grants/revoke", { token: "t", body: { targetType: "nope", targetId: "x", sub: "y" } });
      expect(res.statusCode).toBe(400);
    });
  });

  // Found only by executing (D-55): a hard navigation to /admin has no matching physical file and, unlike
  // "/f/*"/"/t/:token" (registerPreviewRoutes' real server routes), no server-side document route either -
  // it fell straight through to server.ts's setNotFoundHandler (the real 404 page), so the SPA never even
  // loaded and AdminPage's client-side router had nothing to mount into. Unguarded, like "/" itself - the
  // gate is client-side rendering plus the API's 404, never this shell.
  describe("GET /admin - the SPA shell itself, not the app data", () => {
    it("serves the SPA shell (200), not the 404 view - a hard navigation must reach the client router", async () => {
      const res = await req("GET", "/admin");
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain('<div id="root">');
    });

    it("serves the same shell for a signed-out visitor too - no gate on the shell itself", async () => {
      const res = await req("GET", "/admin");
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /api/admin/grants", () => {
    it("lists both a file grant and a collection grant, with target names and owners joined", async () => {
      const file = await seedFile({ ownerSub: "user:owner", name: `f-${randomUUID()}.txt` });
      await grantFileAcl(file.id, "user:file-grantee");
      const collection = await seedCollection("user:owner");
      await grantCollectionAcl(collection.id, "user:collection-grantee", true);

      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("GET", "/api/admin/grants", { token: "t" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { grants: { targetType: string; targetId: string; targetName: string; ownerSub: string; sub: string; canUpload: boolean; status: string }[] };

      const fileGrant = body.grants.find((g) => g.targetType === "file" && g.sub === "user:file-grantee");
      expect(fileGrant).toMatchObject({ targetId: file.id, targetName: file.name, ownerSub: "user:owner", canUpload: false, status: "active" });

      const collectionGrant = body.grants.find((g) => g.targetType === "collection" && g.sub === "user:collection-grantee");
      expect(collectionGrant).toMatchObject({ targetId: collection.id, targetName: collection.name, ownerSub: "user:owner", canUpload: true, status: "active" });
    });

    // Cross-checks Wave A2/A3: the panel shows an expired grant (D-218 - the panel filters nothing), but
    // that same grant does not authorize any longer.
    it("an EXPIRED grant appears in the list as expired, and does not authorize", async () => {
      const file = await seedFile({ ownerSub: "user:owner" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(file.id, sub, new Date(Date.now() - 60_000));

      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("GET", "/api/admin/grants", { token: "t" });
      const body = res.json() as { grants: { targetId: string; sub: string; status: string }[] };
      const grant = body.grants.find((g) => g.targetId === file.id && g.sub === sub);
      expect(grant?.status).toBe("expired");

      expect(await hasAclGrant(file.id, sub)).toBe(false);
    });
  });

  describe("POST /api/admin/grants/revoke", () => {
    it("removes the grant", async () => {
      const file = await seedFile({ ownerSub: "user:owner" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(file.id, sub);

      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("POST", "/api/admin/grants/revoke", {
        token: "t",
        body: { targetType: "file", targetId: file.id, sub },
      });
      expect(res.statusCode).toBe(200);

      expect(await hasAclGrant(file.id, sub)).toBe(false);
    });

    it("removes files:read best-effort", async () => {
      const file = await seedFile({ ownerSub: "user:owner" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(file.id, sub);

      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      await req("POST", "/api/admin/grants/revoke", { token: "t", body: { targetType: "file", targetId: file.id, sub } });
      expect(setAccountRoleMock).toHaveBeenCalledWith(sub, "files:read", "remove");
    });

    it("a second revoke of the same grant still returns 200 (idempotent)", async () => {
      const file = await seedFile({ ownerSub: "user:owner" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(file.id, sub);
      asUser("user:admin", { roles: ["files:write", "files:delete"] });

      const first = await req("POST", "/api/admin/grants/revoke", { token: "t", body: { targetType: "file", targetId: file.id, sub } });
      expect(first.statusCode).toBe(200);
      const second = await req("POST", "/api/admin/grants/revoke", { token: "t", body: { targetType: "file", targetId: file.id, sub } });
      expect(second.statusCode).toBe(200);
    });

    it("an unknown target returns 200 (idempotent, no such grant ever existed)", async () => {
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("POST", "/api/admin/grants/revoke", {
        token: "t",
        body: { targetType: "file", targetId: "no-such-file-id", sub: "user:nobody" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("revoking a COLLECTION grant removes it", async () => {
      const collection = await seedCollection("user:owner");
      const sub = `user:${randomUUID()}`;
      await grantCollectionAcl(collection.id, sub, false);
      asUser("user:admin", { roles: ["files:write", "files:delete"] });

      const res = await req("POST", "/api/admin/grants/revoke", {
        token: "t",
        body: { targetType: "collection", targetId: collection.id, sub },
      });
      expect(res.statusCode).toBe(200);
      expect(await hasCollectionAclGrant(collection.id, sub)).toBe(false);
    });

    // D-23: revocation ends ACCESS, never bytes. A file uploaded through a granted collection must
    // survive its grant being revoked.
    it("does NOT delete files (D-23) - the uploaded file row and bytes survive", async () => {
      const collection = await seedCollection("user:owner", { protection: "private" });
      const sub = `user:${randomUUID()}`;
      await grantCollectionAcl(collection.id, sub, true);
      const file = await seedFile({ collectionId: collection.id, ownerSub: sub });

      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("POST", "/api/admin/grants/revoke", {
        token: "t",
        body: { targetType: "collection", targetId: collection.id, sub },
      });
      expect(res.statusCode).toBe(200);

      const survived = await resolveById(file.id);
      expect(survived).not.toBeNull();
      expect(survived?.bytes).toBeGreaterThan(0);
    });
  });

  describe("GET /api/admin/usage", () => {
    it("reports volume, tracked bytes and file count, byOwner and topCollections shapes", async () => {
      const collection = await seedCollection("user:owner");
      // A deliberately huge byte count - usage.ts's topCollections queries the SAME shared MariaDB every
      // integration test file writes into, so a small, ordinary-sized fixture is not guaranteed a spot in
      // a LIMIT 10 ranking; this one is.
      await seedFile({ collectionId: collection.id, ownerSub: "user:owner", bytes: 999_999_999_999 });

      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await req("GET", "/api/admin/usage", { token: "t" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        volume: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
        tracked: { bytes: number; fileCount: number };
        untrackedBytes: number | null;
        byOwner: { ownerSub: string; bytes: number; fileCount: number }[];
        topCollections: { collectionId: string; name: string; ownerSub: string; bytes: number; fileCount: number }[];
      };
      // The real tmp filesystem always resolves - this asserts a real statfs shape rather than null.
      expect(body.volume).not.toBeNull();
      expect(body.tracked.fileCount).toBeGreaterThan(0);
      expect(body.byOwner.some((r) => r.ownerSub === "user:owner")).toBe(true);
      expect(body.topCollections.some((r) => r.collectionId === collection.id)).toBe(true);
      expect(typeof body.untrackedBytes === "number" || body.untrackedBytes === null).toBe(true);
    });

    it("volume: null degrades to a 200 with untrackedBytes: null, when the storage root is unreachable", async () => {
      const brokenApp = Fastify({ logger: false });
      const brokenConfig = makeTestConfig({ storageRoot: "/no/such/storage/root/at/all" });
      await registerAdminRoutes(brokenApp, brokenConfig);
      await brokenApp.ready();
      try {
        asUser("user:admin", { roles: ["files:write", "files:delete"] });
        const res = await brokenApp.inject({
          method: "GET",
          url: "/api/admin/usage",
          headers: { host: FILES_HOST, authorization: "Bearer t" },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { volume: unknown; untrackedBytes: unknown };
        expect(body.volume).toBeNull();
        expect(body.untrackedBytes).toBeNull();
      } finally {
        await brokenApp.close();
      }
    });
  });
});
