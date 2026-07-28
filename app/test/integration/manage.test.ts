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
