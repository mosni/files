import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerBrowseRoutes } from "../../src/routes/browse.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const verifyMock = vi.mocked(verify);
const FILES_HOST = "files.mosni.dev";

type BrowseResponse = {
  breadcrumb: { id: string; name: string }[];
  collections: {
    id: string;
    name: string;
    effectiveProtection: Protection;
    defaultProtection: Protection;
    reason: string;
    previewUrl: string;
  }[];
  files: {
    id: string;
    name: string;
    effectiveProtection: Protection;
    reason: string;
    previewUrl: string;
    directUrl: string;
  }[];
  nextOffset: number | null;
};

describe("GET /api/browse (§1.4 of the E4 waves hand-off)", () => {
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
    root = await mkdtemp(path.join(os.tmpdir(), "browse-test-"));
    initFilesStorage(root);

    app = Fastify({ logger: false });
    await registerBrowseRoutes(app, makeTestConfig({ storageRoot: root }));
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

  const get = (url: string, token?: string) =>
    app.inject({
      method: "GET",
      url,
      headers: { host: FILES_HOST, ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    });

  async function seedCollection(opts: {
    parentId?: string;
    ownerSub: string;
    protection?: Protection;
    name?: string;
  }) {
    const collection = await createCollection({
      parentId: opts.parentId ?? "",
      name: opts.name ?? `c-${randomUUID()}`,
      ownerSub: opts.ownerSub,
      protection: opts.protection,
    });
    createdCollectionIds.push(collection.id);
    return collection;
  }

  async function seedFile(opts: { collectionId: string; ownerSub: string; protection: Protection; name?: string }) {
    const name = opts.name ?? `f-${randomUUID()}.txt`;
    const claimed = await claimFileRow({
      collectionId: opts.collectionId,
      name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub,
      uploaderSub: opts.ownerSub,
      protection: opts.protection,
    });
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await commitFileRow(claimed.id, { bytes: 7, width: null, height: null, durationSeconds: null, textPreview: null });
    return claimed;
  }

  describe("scope gating", () => {
    it("scope=mine requires a Bearer (401)", async () => {
      expect((await get("/api/browse?scope=mine")).statusCode).toBe(401);
    });

    it("scope=public needs no Bearer at all (D-94)", async () => {
      const res = await get("/api/browse?scope=public");
      expect(res.statusCode).toBe(200);
    });

    it("scope=all 404s for a non-admin (never a role-confirming 403)", async () => {
      asUser("user:plain", { roles: [] });
      expect((await get("/api/browse?scope=all", "t")).statusCode).toBe(404);
    });

    it("scope=all 404s with no Bearer", async () => {
      expect((await get("/api/browse?scope=all")).statusCode).toBe(404);
    });

    it("scope=all is reachable by a holder of both files:write and files:delete", async () => {
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      expect((await get("/api/browse?scope=all", "t")).statusCode).toBe(200);
    });

    it("scope=all is reachable by mosni_owner", async () => {
      asUser("user:root", { mosni_owner: true, roles: [] });
      expect((await get("/api/browse?scope=all", "t")).statusCode).toBe(200);
    });

    it("an invalid scope is 400", async () => {
      expect((await get("/api/browse?scope=bogus")).statusCode).toBe(400);
    });
  });

  describe("scope=public - the app's only anonymous listing endpoint (D-94/AC9, never-delete)", () => {
    it("returns only public-effective rows; an unpublished collection appears for nobody", async () => {
      const pub = await seedCollection({ ownerSub: "user:a", protection: "public", name: `pub-${randomUUID()}` });
      const priv = await seedCollection({ ownerSub: "user:a", protection: "private", name: `priv-${randomUUID()}` });

      const res = await get("/api/browse?scope=public");
      const body = res.json() as BrowseResponse;
      const ids = body.collections.map((c) => c.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(priv.id);
    });

    it("a public file inside a public collection is listed as public", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      const res = await get(`/api/browse?scope=public&collectionId=${collection.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).toContain(file.id);
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("public");
      expect(body.files.find((f) => f.id === file.id)?.effectiveProtection).toBe("public");
    });

    it("a file gated by its collection is absent from the public listing even if stored public itself (never-delete)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      // Drilling directly into the private collection's id is itself refused (D-94's "descend through
      // public all the way down").
      const intoIt = await get(`/api/browse?scope=public&collectionId=${collection.id}`);
      expect(intoIt.statusCode).toBe(404);

      // And it never surfaces from root either.
      const fromRoot = await get("/api/browse?scope=public");
      const body = fromRoot.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).not.toContain(file.id);
      expect(body.collections.map((c) => c.id)).not.toContain(collection.id);
    });

    it("a nested public collection under a public parent is reachable and lists correctly", async () => {
      const parent = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });
      const file = await seedFile({ collectionId: child.id, ownerSub: "user:a", protection: "public" });

      const res = await get(`/api/browse?scope=public&collectionId=${child.id}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).toContain(file.id);
      expect(body.breadcrumb.map((b) => b.id)).toEqual([parent.id, child.id]);
    });

    it("a public collection nested under a PRIVATE parent is not reachable via public scope (chain check, not just own level)", async () => {
      const parent = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });

      expect((await get(`/api/browse?scope=public&collectionId=${child.id}`)).statusCode).toBe(404);
      // Nor does it show up as a child when (hypothetically) listing the parent anonymously.
      const intoParent = await get(`/api/browse?scope=public&collectionId=${parent.id}`);
      expect(intoParent.statusCode).toBe(404);
    });

    it("the copy link offered for a collection-gated file contains no collection name (D-100)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "secret", name: `secretname-${randomUUID()}` });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });
      // secret is listed for the owner only, so use scope=mine as the owner to retrieve the row and
      // inspect its link - the point under test is the URL SHAPE, not who can see it.
      asUser("user:a", { roles: [] });
      const res = await get(`/api/browse?scope=mine&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      const row = body.files.find((f) => f.id === file.id)!;
      expect(row.previewUrl).not.toContain(collection.name);
      expect(row.directUrl).not.toContain(collection.name);
      expect(row.previewUrl).toContain("/t/");
    });
  });

  describe("scope=mine", () => {
    it("shows only the caller's own collections and files, regardless of protection level", async () => {
      const mine = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const theirs = await seedCollection({ ownerSub: "user:b", protection: "public" });

      asUser("user:a", { roles: [] });
      const res = await get("/api/browse?scope=mine", "t");
      const body = res.json() as BrowseResponse;
      const ids = body.collections.map((c) => c.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    it("404s when collectionId belongs to someone else", async () => {
      const theirs = await seedCollection({ ownerSub: "user:b", protection: "public" });
      asUser("user:a", { roles: [] });
      expect((await get(`/api/browse?scope=mine&collectionId=${theirs.id}`, "t")).statusCode).toBe(404);
    });

    it("every row's reason is 'own'", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "secret" });
      asUser("user:a", { roles: [] });
      const res = await get(`/api/browse?scope=mine&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("own");
    });
  });

  describe("scope=all (D-101 admin gate)", () => {
    it("shows every owner's rows", async () => {
      const a = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const b = await seedCollection({ ownerSub: "user:b", protection: "secret" });
      asUser("user:root", { mosni_owner: true, roles: [] });
      const res = await get("/api/browse?scope=all", "t");
      const body = res.json() as BrowseResponse;
      const ids = body.collections.map((c) => c.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it("an admin's OWN row still reports 'own', not 'admin' (own takes precedence)", async () => {
      const mine = await seedCollection({ ownerSub: "user:admin", protection: "private" });
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await get("/api/browse?scope=all", "t");
      const body = res.json() as BrowseResponse;
      expect(body.collections.find((c) => c.id === mine.id)?.reason).toBe("own");
    });

    it("a stranger's row reports 'admin'", async () => {
      const theirs = await seedCollection({ ownerSub: "user:stranger", protection: "private" });
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await get("/api/browse?scope=all", "t");
      const body = res.json() as BrowseResponse;
      expect(body.collections.find((c) => c.id === theirs.id)?.reason).toBe("admin");
    });
  });

  describe("the four VisibilityReason values, and precedence (D-103)", () => {
    it("granted beats admin for a row the admin does not own but has an ACL grant on", async () => {
      const collection = await seedCollection({ ownerSub: "user:stranger", protection: "private" });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        "user:admin",
      ]);
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await get("/api/browse?scope=all", "t");
      const body = res.json() as BrowseResponse;
      expect(body.collections.find((c) => c.id === collection.id)?.reason).toBe("granted");
    });

    it("a stranger with a file-level grant sees it via scope=all as 'granted' (unreachable in-product until E7, directly testable - D-103)", async () => {
      const collection = await seedCollection({ ownerSub: "user:owner", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "private" });
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [file.id, "user:admin"]);
      asUser("user:admin", { roles: ["files:write", "files:delete"] });
      const res = await get(`/api/browse?scope=all&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("granted");
    });
  });

  describe("ordering and pagination (D-102)", () => {
    it("collections come before files, both newest-first", async () => {
      const parent = await seedCollection({ ownerSub: "user:order", protection: "public", name: `order-${randomUUID()}` });
      const fileA = await seedFile({ collectionId: parent.id, ownerSub: "user:order", protection: "public", name: "a.txt" });
      await new Promise((r) => setTimeout(r, 1100)); // created_at is second-resolution TIMESTAMP
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:order", protection: "public" });
      await new Promise((r) => setTimeout(r, 1100));
      const fileB = await seedFile({ collectionId: parent.id, ownerSub: "user:order", protection: "public", name: "b.txt" });

      const res = await get(`/api/browse?scope=public&collectionId=${parent.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.collections.map((c) => c.id)).toEqual([child.id]);
      expect(body.files.map((f) => f.id)).toEqual([fileB.id, fileA.id]); // newest first
    });

    it("nextOffset is null when everything fits on one page", async () => {
      const collection = await seedCollection({ ownerSub: "user:page-small", protection: "public" });
      await seedFile({ collectionId: collection.id, ownerSub: "user:page-small", protection: "public" });
      const res = await get(`/api/browse?scope=public&collectionId=${collection.id}`);
      expect((res.json() as BrowseResponse).nextOffset).toBeNull();
    });

    it("paginates at exactly 100 and 101 rows", async () => {
      const collection = await seedCollection({ ownerSub: "user:page-big", protection: "public" });
      for (let i = 0; i < 100; i++) {
        await seedFile({ collectionId: collection.id, ownerSub: "user:page-big", protection: "public", name: `n${i}.txt` });
      }
      const firstPage = await get(`/api/browse?scope=public&collectionId=${collection.id}`);
      const firstBody = firstPage.json() as BrowseResponse;
      expect(firstBody.files).toHaveLength(100);
      expect(firstBody.nextOffset).toBeNull(); // exactly 100 - nothing more

      await seedFile({ collectionId: collection.id, ownerSub: "user:page-big", protection: "public", name: "n100.txt" });
      const withExtra = await get(`/api/browse?scope=public&collectionId=${collection.id}`);
      const withExtraBody = withExtra.json() as BrowseResponse;
      expect(withExtraBody.files).toHaveLength(100);
      expect(withExtraBody.nextOffset).toBe(100);

      const secondPage = await get(`/api/browse?scope=public&collectionId=${collection.id}&offset=100`);
      const secondBody = secondPage.json() as BrowseResponse;
      expect(secondBody.files).toHaveLength(1);
      expect(secondBody.nextOffset).toBeNull();
    }, 30_000);
  });

  describe("breadcrumb", () => {
    it("is empty at root", async () => {
      const res = await get("/api/browse?scope=public");
      expect((res.json() as BrowseResponse).breadcrumb).toEqual([]);
    });

    it("navigates root-first into and back out of nested collections", async () => {
      const top = await seedCollection({ ownerSub: "user:crumb", protection: "public" });
      const mid = await seedCollection({ parentId: top.id, ownerSub: "user:crumb", protection: "public" });
      const deep = await seedCollection({ parentId: mid.id, ownerSub: "user:crumb", protection: "public" });

      const res = await get(`/api/browse?scope=public&collectionId=${deep.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.breadcrumb).toEqual([
        { id: top.id, name: top.name },
        { id: mid.id, name: mid.name },
        { id: deep.id, name: deep.name },
      ]);
    });
  });

  describe("404s rather than 500s for a nonexistent collectionId", () => {
    it.each(["mine", "public", "all"] as const)("scope=%s", async (scope) => {
      asUser("user:root", { mosni_owner: true, roles: ["files:write", "files:delete"] });
      const res = await get(`/api/browse?scope=${scope}&collectionId=${randomUUID()}`, "t");
      expect(res.statusCode).toBe(404);
    });
  });
});
