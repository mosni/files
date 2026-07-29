import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerManageRoutes } from "../../src/routes/manage.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage, resolveById } from "../../src/storage/files.ts";
import { createCollection, resolveCollectionById } from "../../src/storage/collections.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const verifyMock = vi.mocked(verify);
const FILES_HOST = "files.mosni.dev";

describe("routes/manage.ts + controllers/manage.ts (E3 §1.5 mutation API)", () => {
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
    root = await mkdtemp(path.join(os.tmpdir(), "manage-test-"));
    initFilesStorage(root);

    app = Fastify({ logger: false });
    await registerManageRoutes(app, makeTestConfig({ storageRoot: root }));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  const createdCollectionIds: string[] = [];

  afterEach(async () => {
    vi.mocked(verify).mockReset();
    // A test that renames a collection to a fixed literal ("renamed", "root-renamed") must not collide
    // with a leftover row from an earlier run against this same shared MariaDB (D-45) - clean up every
    // collection (and its files) this file created, not just the ones still under their seeded name.
    while (createdCollectionIds.length > 0) {
      const id = createdCollectionIds.pop()!;
      const [fileRows] = await getPool().query("SELECT id FROM files WHERE collection_id = ?", [id]);
      for (const row of fileRows as { id: string }[]) {
        await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [row.id]);
        await getPool().query("DELETE FROM files WHERE id = ?", [row.id]);
      }
      await getPool().query("DELETE FROM collections WHERE id = ?", [id]);
    }
  });

  function asUser(sub: string, extra: Record<string, unknown> = {}): void {
    verifyMock.mockResolvedValue({ sub, ...extra } as never);
  }

  const req = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    opts: { token?: string; body?: Record<string, unknown> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: FILES_HOST,
        ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      payload: opts.body,
    });

  async function seedCollection(ownerSub: string, name = `c-${randomUUID()}`) {
    const collection = await createCollection({ parentId: "", name, ownerSub });
    createdCollectionIds.push(collection.id);
    return collection;
  }

  async function seedFile(opts: {
    collectionId: string;
    name?: string;
    ownerSub?: string | null;
    protection?: Protection;
  }) {
    const name = opts.name ?? `file-${randomUUID()}.txt`;
    const claimed = await claimFileRow({
      collectionId: opts.collectionId,
      name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub === undefined ? "user:owner" : (opts.ownerSub ?? "no-owner"),
      uploaderSub: "user:owner",
      protection: opts.protection ?? "unlisted",
    });
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await commitFileRow(claimed.id, { bytes: 7, width: null, height: null, durationSeconds: null, textPreview: null });
    return claimed;
  }

  describe("GET /api/collections", () => {
    it("401s with no bearer", async () => {
      expect((await req("GET", "/api/collections")).statusCode).toBe(401);
    });

    it("returns only the caller's own collections", async () => {
      const mine = await seedCollection("user:list-a");
      await seedCollection("user:list-b");
      asUser("user:list-a");
      const res = await req("GET", "/api/collections", { token: "t" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string }[];
      expect(body.map((c) => c.id)).toContain(mine.id);
    });
  });

  describe("POST /api/collections", () => {
    it("creates a root-level collection owned by the caller", async () => {
      asUser("user:creator");
      const res = await req("POST", "/api/collections", { token: "t", body: { name: `new-${randomUUID()}` } });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ parentId: "", ownerSub: "user:creator" });
    });

    it("409s on a sibling name collision", async () => {
      const name = `dup-${randomUUID()}`;
      asUser("user:a");
      await req("POST", "/api/collections", { token: "t", body: { name } });
      const res = await req("POST", "/api/collections", { token: "t", body: { name } });
      expect(res.statusCode).toBe(409);
    });

    it("404s creating a nested collection under a parent the caller cannot upload to", async () => {
      const parent = await seedCollection("user:someone-else");
      asUser("user:outsider");
      const res = await req("POST", "/api/collections", {
        token: "t",
        body: { parentId: parent.id, name: "child" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("allows a nested collection under the caller's own parent", async () => {
      asUser("user:nester");
      const parent = await seedCollection("user:nester");
      const res = await req("POST", "/api/collections", {
        token: "t",
        body: { parentId: parent.id, name: "child" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ parentId: parent.id });
    });

    // Review session 017: collection names are URL segments too, and this endpoint is user-facing (Wave
    // G's "new collection" field types straight into it).
    it.each([["x/y"], [".."], [" lead"], ["ctl\u0001"]])(
      "rejects a collection name of %j with 400",
      async (hostile) => {
        asUser("user:creator");
        const res = await req("POST", "/api/collections", { token: "t", body: { name: hostile } });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid_name" });
      },
    );

    // `/t/:token` is a static route on both origins and outranks the `/*` wildcard, so a ROOT collection
    // named "t" makes every file inside it unreachable by its readable link. controllers/upload.ts has
    // always guarded the DERIVED default name against this; the user-facing endpoint did not.
    it("rejects a root-level collection named \"t\" (it would shadow /t/<token>)", async () => {
      asUser("user:creator");
      const res = await req("POST", "/api/collections", { token: "t", body: { name: "t" } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_name" });
    });

    it("allows a NESTED collection named \"t\" (only the root level shadows a route)", async () => {
      asUser("user:nester-t");
      const parent = await seedCollection("user:nester-t");
      const res = await req("POST", "/api/collections", {
        token: "t",
        body: { parentId: parent.id, name: "t" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("a root-level collection defaults to unlisted protection (D-105)", async () => {
      asUser("user:creator");
      const res = await req("POST", "/api/collections", { token: "t", body: { name: `root-prot-${randomUUID()}` } });
      expect(res.json()).toMatchObject({ protection: "unlisted" });
    });

    it("a nested collection inherits its parent's EFFECTIVE protection, not just the parent's own value (D-105)", async () => {
      asUser("user:nester2");
      const grandparent = await seedCollection("user:nester2");
      await getPool().query("UPDATE collections SET protection = 'private' WHERE id = ?", [grandparent.id]);
      const parentRes = await req("POST", "/api/collections", {
        token: "t",
        body: { parentId: grandparent.id, name: "parent" },
      });
      // The parent itself was created with no explicit level, so it also inherited 'private' from the
      // grandparent - confirming the inheritance is EFFECTIVE, not just one level shallow.
      expect(parentRes.json()).toMatchObject({ protection: "private" });

      const childRes = await req("POST", "/api/collections", {
        token: "t",
        body: { parentId: (parentRes.json() as { id: string }).id, name: "child" },
      });
      expect(childRes.json()).toMatchObject({ protection: "private" });
    });
  });

  describe("PATCH /api/collections/:id", () => {
    it("renames as owner", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:owner");
      const res = await req("PATCH", `/api/collections/${collection.id}`, {
        token: "t",
        body: { name: "renamed" },
      });
      expect(res.statusCode).toBe(200);
      expect((await resolveCollectionById(collection.id))?.name).toBe("renamed");
    });

    it("404s for a non-owner, non-superuser", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:someone-else");
      const res = await req("PATCH", `/api/collections/${collection.id}`, { token: "t", body: { name: "x" } });
      expect(res.statusCode).toBe(404);
    });

    it("a mosni_owner superuser may rename anyone's collection", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:root", { mosni_owner: true });
      const res = await req("PATCH", `/api/collections/${collection.id}`, {
        token: "t",
        body: { name: "root-renamed" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("changes defaultProtection", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:owner");
      const res = await req("PATCH", `/api/collections/${collection.id}`, {
        token: "t",
        body: { defaultProtection: "private" },
      });
      expect(res.statusCode).toBe(200);
      expect((await resolveCollectionById(collection.id))?.defaultProtection).toBe("private");
    });

    it("changes the collection's OWN protection (D-95, distinct from defaultProtection)", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:owner");
      const res = await req("PATCH", `/api/collections/${collection.id}`, {
        token: "t",
        body: { protection: "secret" },
      });
      expect(res.statusCode).toBe(200);
      const updated = await resolveCollectionById(collection.id);
      expect(updated?.protection).toBe("secret");
      expect(updated?.defaultProtection).toBe("unlisted"); // untouched - the two columns are distinct
    });

    describe("write-time floor (D-97)", () => {
      it("rejects setting a collection's OWN protection below its PARENT's effective level", async () => {
        const parent = await seedCollection("user:floor");
        await getPool().query("UPDATE collections SET protection = 'private' WHERE id = ?", [parent.id]);
        const child = await createCollection({ parentId: parent.id, name: "child", ownerSub: "user:floor", protection: "private" });
        createdCollectionIds.push(child.id);

        asUser("user:floor");
        const res = await req("PATCH", `/api/collections/${child.id}`, { token: "t", body: { protection: "public" } });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "below_parent_protection" });
        expect((await resolveCollectionById(child.id))?.protection).toBe("private"); // unchanged
      });

      it("allows raising a collection's OWN protection above its parent's", async () => {
        const parent = await seedCollection("user:floor2");
        const child = await createCollection({ parentId: parent.id, name: "child", ownerSub: "user:floor2" });
        createdCollectionIds.push(child.id);

        asUser("user:floor2");
        const res = await req("PATCH", `/api/collections/${child.id}`, { token: "t", body: { protection: "private" } });
        expect(res.statusCode).toBe(200);
      });

      it("a ROOT collection has no parent floor - any level is accepted", async () => {
        const root = await seedCollection("user:floor3");
        asUser("user:floor3");
        const res = await req("PATCH", `/api/collections/${root.id}`, { token: "t", body: { protection: "public" } });
        expect(res.statusCode).toBe(200);
      });

      it("rejects setting defaultProtection below the collection's OWN effective level", async () => {
        const collection = await seedCollection("user:floor4");
        await getPool().query("UPDATE collections SET protection = 'secret' WHERE id = ?", [collection.id]);

        asUser("user:floor4");
        const res = await req("PATCH", `/api/collections/${collection.id}`, {
          token: "t",
          body: { defaultProtection: "public" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "below_parent_protection" });
      });

      it("a protection change and a defaultProtection change in the SAME request compose correctly", async () => {
        const collection = await seedCollection("user:floor5");
        asUser("user:floor5");
        // Raising protection to 'secret' in this request, then setting defaultProtection to 'secret' too
        // (exactly at the just-raised floor) must succeed - defaultProtection's floor check must see the
        // NEW protection value, not the one from before this request.
        const res = await req("PATCH", `/api/collections/${collection.id}`, {
          token: "t",
          body: { protection: "secret", defaultProtection: "secret" },
        });
        expect(res.statusCode).toBe(200);
      });

      it("raising a collection's protection leaves a descendant FILE's stored protection untouched, only its EFFECTIVE level changes", async () => {
        const collection = await seedCollection("user:floor6");
        const claimed = await claimFileRow({
          collectionId: collection.id,
          name: "floor-file.txt",
          diskDir: "2026/07",
          diskName: `${randomUUID()}-floor-file.txt`,
          ownerSub: "user:floor6",
          uploaderSub: "user:floor6",
          protection: "unlisted",
        });
        const abs = path.join(root, ...diskRelPath(claimed).split("/"));
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, "x");
        await commitFileRow(claimed.id, { bytes: 1, width: null, height: null, durationSeconds: null, textPreview: null });

        asUser("user:floor6");
        const raise = await req("PATCH", `/api/collections/${collection.id}`, {
          token: "t",
          body: { protection: "private" },
        });
        expect(raise.statusCode).toBe(200);

        const raisedFile = await resolveById(claimed.id);
        expect(raisedFile?.protection).toBe("unlisted"); // D-97: the row itself is untouched

        // Lowering the collection again restores the file's previous per-file behaviour exactly - which
        // only makes sense because its stored level was never rewritten.
        const lower = await req("PATCH", `/api/collections/${collection.id}`, {
          token: "t",
          body: { protection: "unlisted" },
        });
        expect(lower.statusCode).toBe(200);
        expect((await resolveById(claimed.id))?.protection).toBe("unlisted");
      });
    });

    it("rejects a rename to an unsafe segment with 400", async () => {
      const collection = await seedCollection("user:owner", `keep-${randomUUID()}`);
      asUser("user:owner");
      const res = await req("PATCH", `/api/collections/${collection.id}`, { token: "t", body: { name: "a/b" } });
      expect(res.statusCode).toBe(400);
      expect((await resolveCollectionById(collection.id))?.name).toBe(collection.name);
    });

    it("rejects renaming a ROOT collection to \"t\" (it would shadow /t/<token>)", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:owner");
      const res = await req("PATCH", `/api/collections/${collection.id}`, { token: "t", body: { name: "t" } });
      expect(res.statusCode).toBe(400);
    });

    it("409s on a rename that collides with a sibling", async () => {
      const taken = `taken-${randomUUID()}`;
      await seedCollection("user:owner", taken);
      const collection = await seedCollection("user:owner");
      asUser("user:owner");
      const res = await req("PATCH", `/api/collections/${collection.id}`, { token: "t", body: { name: taken } });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("DELETE /api/collections/:id (D-88 recursive)", () => {
    it("owner can recursively delete, removing descendant files and bytes", async () => {
      const top = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: top.id, ownerSub: "user:owner" });

      asUser("user:owner");
      const res = await req("DELETE", `/api/collections/${top.id}`, { token: "t" });
      expect(res.statusCode).toBe(204);
      expect(await resolveById(file.id)).toBeNull();
      expect(await resolveCollectionById(top.id)).toBeNull();
    });

    it("404s for a non-owner", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:someone-else");
      expect((await req("DELETE", `/api/collections/${collection.id}`, { token: "t" })).statusCode).toBe(404);
    });

    // D-104: the browser's own confirmation must name the descendant count before the owner commits.
    it("a dryRun request reports descendant counts and deletes nothing", async () => {
      const top = await seedCollection("user:owner");
      const child = await createCollection({ parentId: top.id, name: "child", ownerSub: "user:owner" });
      createdCollectionIds.push(child.id);
      await seedFile({ collectionId: top.id, ownerSub: "user:owner" });
      await seedFile({ collectionId: child.id, ownerSub: "user:owner" });

      asUser("user:owner");
      const res = await req("DELETE", `/api/collections/${top.id}?dryRun=true`, { token: "t" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ collectionCount: 2, fileCount: 2 });
      expect(await resolveCollectionById(top.id)).not.toBeNull();
      expect(await resolveCollectionById(child.id)).not.toBeNull();
    });

    it("dryRun 404s for a non-owner same as a real delete would", async () => {
      const collection = await seedCollection("user:owner");
      asUser("user:someone-else");
      const res = await req("DELETE", `/api/collections/${collection.id}?dryRun=true`, { token: "t" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/files/:id", () => {
    it("renames as owner", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, name: "old.txt", ownerSub: "user:owner" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { name: "new.txt" } });
      expect(res.statusCode).toBe(200);
      expect((await resolveById(file.id))?.name).toBe("new.txt");
    });

    it("404s for a non-owner, non-superuser (a files:delete holder may NOT rename)", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner" });
      asUser("user:has-delete-role", { roles: ["files:delete"] });
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { name: "x.txt" } });
      expect(res.statusCode).toBe(404);
    });

    it("changes protection level", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "unlisted" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { protection: "private" } });
      expect(res.statusCode).toBe(200);
      expect((await resolveById(file.id))?.protection).toBe("private");
    });

    describe("write-time floor (D-97)", () => {
      it("rejects setting a file's protection below its collection's effective level", async () => {
        const collection = await seedCollection("user:file-floor");
        await getPool().query("UPDATE collections SET protection = 'private' WHERE id = ?", [collection.id]);
        const file = await seedFile({ collectionId: collection.id, ownerSub: "user:file-floor", protection: "private" });

        asUser("user:file-floor");
        const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { protection: "public" } });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "below_parent_protection" });
        expect((await resolveById(file.id))?.protection).toBe("private"); // unchanged
      });

      it("allows raising a file's protection above its collection's", async () => {
        const collection = await seedCollection("user:file-floor2");
        const file = await seedFile({ collectionId: collection.id, ownerSub: "user:file-floor2", protection: "unlisted" });

        asUser("user:file-floor2");
        const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { protection: "private" } });
        expect(res.statusCode).toBe(200);
      });
    });

    it("409s on a rename that collides with a sibling in the same collection", async () => {
      const collection = await seedCollection("user:owner");
      await seedFile({ collectionId: collection.id, name: "taken.txt", ownerSub: "user:owner" });
      const file = await seedFile({ collectionId: collection.id, name: "mine.txt", ownerSub: "user:owner" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { name: "taken.txt" } });
      expect(res.statusCode).toBe(409);
    });

    it("a rejected protection value is a 400, not silently ignored", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { protection: "bogus" } });
      expect(res.statusCode).toBe(400);
    });

    // Review session 017: a display name IS a URL segment (D-81 resolves /f/... by display name), so a
    // rename must pass the same safeSegment() gate an uploaded filename does. Without this the row is
    // renamed successfully and becomes permanently unreachable at its own readable link.
    it.each([["a/b.txt"], [".."], ["  spaced.txt"], ["nul\u0000.txt"], ["trailing "]])(
      "rejects a rename to %j with 400 and leaves the name unchanged",
      async (hostile) => {
        const collection = await seedCollection("user:owner");
        const file = await seedFile({ collectionId: collection.id, name: "keep.txt", ownerSub: "user:owner" });
        asUser("user:owner");
        const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { name: hostile } });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid_name" });
        expect((await resolveById(file.id))?.name).toBe("keep.txt");
      },
    );

    // Review session 017: the response has to carry the URLs, because a rename and a protection change
    // both retire them and the SPA cannot recompute them (it never sees the link_token).
    it("returns the updated preview context, with URLs reflecting the new name", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, name: "before.txt", ownerSub: "user:owner" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { name: "after.txt" } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("after.txt");
      expect(body.previewUrl).toContain(`${encodeURIComponent(collection.name)}/after.txt`);
      expect(body.directUrl).toContain(`${encodeURIComponent(collection.name)}/after.txt`);
      expect(body.previewUrl).not.toContain("before.txt");
    });

    it("returns the /t/<token> URL shape after a change to `secret`", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "unlisted" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { protection: "secret" } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The readable path 404s for a `secret` file (D-59), so both links must move onto the token.
      expect(body.previewUrl).toContain(`/t/${file.linkToken}`);
      expect(body.directUrl).toContain(`/t/${file.linkToken}`);
    });

    it("returns a signed directUrl after a change to `private` (D-84)", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "unlisted" });
      asUser("user:owner");
      const res = await req("PATCH", `/api/files/${file.id}`, { token: "t", body: { protection: "private" } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Without this the owner's own preview stops rendering the bytes the moment they make it private.
      expect(body.directUrl).toContain(`/s/${file.id}?exp=`);
      expect(body.directUrl).toContain("&sig=");
    });
  });

  describe("DELETE /api/files/:id (D-16 hard delete)", () => {
    it("the owner may delete; the link 404s afterwards", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner" });
      asUser("user:owner");
      expect((await req("DELETE", `/api/files/${file.id}`, { token: "t" })).statusCode).toBe(204);
      expect(await resolveById(file.id)).toBeNull();
    });

    it("a files:delete holder may delete another user's file", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner" });
      asUser("user:deleter", { roles: ["files:delete"] });
      expect((await req("DELETE", `/api/files/${file.id}`, { token: "t" })).statusCode).toBe(204);
    });

    it("a mosni_owner superuser may delete anyone's file", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner" });
      asUser("user:root", { mosni_owner: true });
      expect((await req("DELETE", `/api/files/${file.id}`, { token: "t" })).statusCode).toBe(204);
    });

    it("a stranger with no elevated role gets 404, not 403", async () => {
      const collection = await seedCollection("user:owner");
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner" });
      asUser("user:stranger");
      expect((await req("DELETE", `/api/files/${file.id}`, { token: "t" })).statusCode).toBe(404);
    });

    it("deleting an unknown id 404s", async () => {
      asUser("user:owner");
      const res = await req("DELETE", "/api/files/doesnotexist0000", { token: "t" });
      expect(res.statusCode).toBe(404);
    });
  });
});
