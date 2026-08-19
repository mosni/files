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
import { verifyDelivery } from "../../src/lib/deliverySignature.ts";
import type { Protection } from "../../src/lib/protection.ts";

const verifyMock = vi.mocked(verify);
const FILES_HOST = "files.mosni.dev";

type BrowseResponse = {
  breadcrumb: { id: string; name: string; previewUrl: string }[];
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
    thumbUrl: string | null;
  }[];
  nextOffset: number | null;
  canUpload: boolean;
  canManage: boolean;
};

describe("GET /api/browse (§1.4 of the E4 waves hand-off, collapsed to two scopes by D-116)", () => {
  let root: string;
  let app: FastifyInstance;
  let config: ReturnType<typeof makeTestConfig>;

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
    config = makeTestConfig({ storageRoot: root });
    await registerBrowseRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  const createdCollectionIds: string[] = [];
  // D-126 (E4.1 live-testing findings, Wave A): a root-level file has no owning collection to clean up
  // through - tracked and deleted directly.
  const createdRootFileIds: string[] = [];

  afterEach(async () => {
    vi.mocked(verify).mockReset();
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

  function asAdmin(sub: string): void {
    asUser(sub, { roles: ["files:write", "files:delete"] });
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

  async function seedFile(opts: {
    collectionId: string;
    ownerSub: string;
    protection: Protection;
    name?: string;
    withThumb?: boolean;
  }) {
    const name = opts.name ?? `f-${randomUUID()}.txt`;
    const claimed = await claimFileRow({
      collectionId: opts.collectionId,
      name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub,
      uploaderSub: opts.ownerSub,
      protection: opts.protection,
      uploaderName: null,
    });
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    const thumbName = opts.withThumb === true ? `${claimed.id}-thumb.webp` : null;
    if (thumbName !== null) {
      await writeFile(path.join(path.dirname(abs), thumbName), "fake-thumbnail-bytes");
    }
    await commitFileRow(claimed.id, { bytes: 7, width: null, height: null, durationSeconds: null, textPreview: null, thumbName, isText: false });
    return claimed;
  }

  describe("scope gating (D-116: only mine/visible are valid; public/all are deleted, not deprecated)", () => {
    it("scope=mine requires a Bearer (401)", async () => {
      expect((await get("/api/browse?scope=mine")).statusCode).toBe(401);
    });

    it("scope=visible needs no Bearer at all (D-94)", async () => {
      const res = await get("/api/browse?scope=visible");
      expect(res.statusCode).toBe(200);
    });

    it("scope=public is deleted - 400 invalid_scope, not the old anonymous listing", async () => {
      const res = await get("/api/browse?scope=public");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_scope" });
    });

    it("scope=all is deleted - 400 invalid_scope, even for an admin", async () => {
      asAdmin("user:admin");
      const res = await get("/api/browse?scope=all", "t");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_scope" });
    });

    it("an invalid scope is 400", async () => {
      expect((await get("/api/browse?scope=bogus")).statusCode).toBe(400);
    });
  });

  describe("scope=visible, anonymous viewer (D-94/D-116, never-delete)", () => {
    it("returns only public-effective rows at root, with unlisted/secret/private collections seeded alongside", async () => {
      const pub = await seedCollection({ ownerSub: "user:a", protection: "public", name: `pub-${randomUUID()}` });
      const unlisted = await seedCollection({ ownerSub: "user:a", protection: "unlisted", name: `unl-${randomUUID()}` });
      const secret = await seedCollection({ ownerSub: "user:a", protection: "secret", name: `sec-${randomUUID()}` });
      const priv = await seedCollection({ ownerSub: "user:a", protection: "private", name: `priv-${randomUUID()}` });

      const res = await get("/api/browse?scope=visible");
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      const ids = body.collections.map((c) => c.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(unlisted.id);
      expect(ids).not.toContain(secret.id);
      expect(ids).not.toContain(priv.id);
      for (const row of body.collections) expect(row.effectiveProtection).toBe("public");
    });

    it("a public file inside a public collection is listed as public", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).toContain(file.id);
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("public");
      expect(body.files.find((f) => f.id === file.id)?.effectiveProtection).toBe("public");
    });

    it("a listed row's thumbUrl reflects whether it has a thumbnail (D-137) - null for a pre-E5/non-image row", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const withThumb = await seedFile({
        collectionId: collection.id,
        ownerSub: "user:a",
        protection: "public",
        withThumb: true,
      });
      const noThumb = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === withThumb.id)?.thumbUrl).toContain("/thumb/");
      expect(body.files.find((f) => f.id === noThumb.id)?.thumbUrl).toBeNull();
    });

    it("a file gated by its collection is absent from every anonymous listing even if stored public itself, and the target 404s without leaking the collection name (never-delete, D-100)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private", name: `gated-${randomUUID()}` });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      const intoIt = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      expect(intoIt.statusCode).toBe(404);
      expect(intoIt.body).not.toContain(collection.name);

      const fromRoot = await get("/api/browse?scope=visible");
      const body = fromRoot.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).not.toContain(file.id);
      expect(body.collections.map((c) => c.id)).not.toContain(collection.id);
    });

    it("a nested public collection under a public parent is reachable and lists correctly", async () => {
      const parent = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });
      const file = await seedFile({ collectionId: child.id, ownerSub: "user:a", protection: "public" });

      const res = await get(`/api/browse?scope=visible&collectionId=${child.id}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).toContain(file.id);
      expect(body.breadcrumb.map((b) => b.id)).toEqual([parent.id, child.id]);
      // E4.1 Wave C: each crumb carries its OWN previewUrl (D-100 - the client never constructs one), a
      // full path built up to and including that crumb, not just its own name in isolation.
      expect(body.breadcrumb.find((b) => b.id === parent.id)?.previewUrl).toContain(`/f/${parent.name}`);
      expect(body.breadcrumb.find((b) => b.id === child.id)?.previewUrl).toContain(`/f/${parent.name}/${child.name}`);
    });

    it("a breadcrumb crumb's previewUrl reflects ITS OWN effective protection, not the leaf's (D-96)", async () => {
      const parent = await seedCollection({ ownerSub: "user:a", protection: "secret" });
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });
      asUser("user:a", { roles: [] });

      const res = await get(`/api/browse?scope=visible&collectionId=${child.id}`, "t");
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      // The parent's own crumb is secret -> its previewUrl is token-shaped, never /f/<name>.
      const parentCrumb = body.breadcrumb.find((b) => b.id === parent.id);
      expect(parentCrumb?.previewUrl).not.toContain(`/f/${parent.name}`);
      expect(parentCrumb?.previewUrl).toContain(`/t/${parent.linkToken}`);
    });

    it("a breadcrumb never leaks a SECRET ancestor's real token to a viewer granted only on a deeper nested child (D-100)", async () => {
      const parent = await seedCollection({ ownerSub: "user:a", protection: "secret" });
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });
      // Granted on the CHILD only - never on the secret parent above it.
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        child.id,
        "user:granted-deep",
      ]);
      asUser("user:granted-deep", { roles: [] });

      const res = await get(`/api/browse?scope=visible&collectionId=${child.id}`, "t");
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      const parentCrumb = body.breadcrumb.find((b) => b.id === parent.id);
      // The crumb still names the ancestor (orientation), but its previewUrl must NOT carry the real
      // token this viewer was never granted - a dead /f/ link (404s for everyone) is safe; the real
      // token is a live credential that would let them reach the parent's own listing directly.
      expect(parentCrumb?.name).toBe(parent.name);
      expect(parentCrumb?.previewUrl).not.toContain(parent.linkToken);
    });

    it("a public collection nested under a PRIVATE parent is not reachable via scope=visible (chain check, not just own level)", async () => {
      const parent = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });

      expect((await get(`/api/browse?scope=visible&collectionId=${child.id}`)).statusCode).toBe(404);
      // Nor does it show up as a child when (hypothetically) listing the parent anonymously.
      const intoParent = await get(`/api/browse?scope=visible&collectionId=${parent.id}`);
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

  // E4.1 Wave A/D-116: browsing a collection's own contents for a viewer who is authorized but not the
  // owner - the reachability gate that used to be scope=public's "elevated" branch is now scope=visible's.
  describe("scope=visible, a non-owner authorized viewer reaching a non-public target (D-98/D-99)", () => {
    it("an anonymous request with the collection's own token resolves a secret collection's listing (D-98)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "secret" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}&token=${collection.linkToken}`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as BrowseResponse).files.map((f) => f.id)).toContain(file.id);
    });

    it("a wrong or missing token still 404s a secret collection's listing", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "secret" });

      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}&token=wrong`)).statusCode).toBe(404);
      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}`)).statusCode).toBe(404);
    });

    it("the owner may browse their own private collection under scope=visible too, not only scope=mine", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      asUser("user:a", { roles: [] });

      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t")).statusCode).toBe(200);
    });

    it("an owner's non-public rows are actually listed under scope=visible, not just the target itself reachable", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "unlisted" });
      asUser("user:a", { roles: [] });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).toContain(file.id);
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("own");
    });

    it("a superuser (mosni_owner) may browse any private collection under scope=visible", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      asUser("user:root", { mosni_owner: true, roles: [] });

      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t")).statusCode).toBe(200);
    });

    it("a superuser's browse of a private collection under scope=visible lists its non-public rows too", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "private" });
      asUser("user:root", { mosni_owner: true, roles: [] });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).files.map((f) => f.id)).toContain(file.id);
    });

    it("an ACL grant on the collection itself grants scope=visible access for a non-owner (D-99)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        collection.id,
        "user:granted",
      ]);
      asUser("user:granted", { roles: [] });

      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t")).statusCode).toBe(200);
    });

    it("an ACL-granted non-owner's browse under scope=visible lists the collection's non-public rows too", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "private" });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        collection.id,
        "user:granted",
      ]);
      asUser("user:granted", { roles: [] });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.files.map((f) => f.id)).toContain(file.id);
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("granted");
    });

    it("an ACL grant on an ANCESTOR pierces down to a private descendant under scope=visible (D-99)", async () => {
      const top = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const child = await seedCollection({ parentId: top.id, ownerSub: "user:a", protection: "private" });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        top.id,
        "user:granted",
      ]);
      asUser("user:granted", { roles: [] });

      expect((await get(`/api/browse?scope=visible&collectionId=${child.id}`, "t")).statusCode).toBe(200);
    });

    it("an unrelated signed-in stranger with no grant still 404s under scope=visible (never-delete)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "private" });
      asUser("user:stranger", { roles: [] });

      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t")).statusCode).toBe(404);
    });

    // D-125 (E4.1 live-testing findings, Wave B): INVERTED, not deleted. A token-holder on a secret
    // collection now sees its public/unlisted rows too (§3.1's narrowed invariant) - a secret/private row
    // inside it stays absent (B4). The companion test right below takes over the invariant half this test
    // used to hold: a stranger with NO token still sees nothing.
    it("a stranger who reaches a secret collection via its token sees its public+unlisted rows, never its secret/private rows (D-125)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "secret" });
      const publicFile = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });
      const unlistedFile = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "unlisted" });
      const secretFile = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "secret" });
      const privateFile = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "private" });

      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}&token=${collection.linkToken}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      const ids = body.files.map((f) => f.id);
      expect(ids).toContain(publicFile.id);
      expect(ids).toContain(unlistedFile.id);
      expect(ids).not.toContain(secretFile.id);
      expect(ids).not.toContain(privateFile.id);
    });

    // Takes over the invariant half of the test above: possession of the link is what grants the
    // listing (D-124/D-125) - a stranger with no token and no identity still sees nothing at all.
    it("a stranger with NO token reaching the same secret collection still 404s (never-delete, unchanged)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "secret" });
      await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

      expect((await get(`/api/browse?scope=visible&collectionId=${collection.id}`)).statusCode).toBe(404);
    });

    // AC6/AC8 (D-124/D-125): the OTHER link shape - a viewer who merely knows an unlisted collection's id
    // (its readable /f/ path is the credential, D-59) needs no token at all, unlike secret.
    describe("an unlisted collection is reachable by anyone, no token needed (D-124)", () => {
      it("an anonymous viewer lists an unlisted collection's public+unlisted rows, never its secret/private rows", async () => {
        const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
        const publicFile = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });
        const unlistedFile = await seedFile({
          collectionId: collection.id,
          ownerSub: "user:a",
          protection: "unlisted",
        });
        const secretFile = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "secret" });
        const privateFile = await seedFile({
          collectionId: collection.id,
          ownerSub: "user:a",
          protection: "private",
        });
        const publicChild = await seedCollection({
          parentId: collection.id,
          ownerSub: "user:a",
          protection: "public",
        });
        const privateChild = await seedCollection({
          parentId: collection.id,
          ownerSub: "user:a",
          protection: "private",
        });

        const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
        expect(res.statusCode).toBe(200);
        const body = res.json() as BrowseResponse;
        const fileIds = body.files.map((f) => f.id);
        expect(fileIds).toContain(publicFile.id);
        expect(fileIds).toContain(unlistedFile.id);
        expect(fileIds).not.toContain(secretFile.id);
        expect(fileIds).not.toContain(privateFile.id);
        const collectionIds = body.collections.map((c) => c.id);
        expect(collectionIds).toContain(publicChild.id);
        expect(collectionIds).not.toContain(privateChild.id);
        for (const row of [...body.files, ...body.collections]) expect(row.reason).toBe("granted");
      });

      it("a signed-in non-owner additionally sees rows they own or hold a grant on, inside that same unlisted collection", async () => {
        const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
        const ownedByViewer = await seedFile({
          collectionId: collection.id,
          ownerSub: "user:viewer",
          protection: "private",
        });
        const grantedFile = await seedFile({
          collectionId: collection.id,
          ownerSub: "user:a",
          protection: "secret",
        });
        await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [grantedFile.id, "user:viewer"]);
        const strangerPrivateFile = await seedFile({
          collectionId: collection.id,
          ownerSub: "user:a",
          protection: "private",
        });
        asUser("user:viewer", { roles: [] });

        const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
        expect(res.statusCode).toBe(200);
        const ids = (res.json() as BrowseResponse).files.map((f) => f.id);
        expect(ids).toContain(ownedByViewer.id);
        expect(ids).toContain(grantedFile.id);
        expect(ids).not.toContain(strangerPrivateFile.id);
      });
    });

    it("the root listing is untouched by D-125: anonymous scope=visible at root still returns only public rows", async () => {
      const pub = await seedCollection({ ownerSub: "user:a", protection: "public", name: `root-pub-${randomUUID()}` });
      const unlisted = await seedCollection({
        ownerSub: "user:a",
        protection: "unlisted",
        name: `root-unl-${randomUUID()}`,
      });

      const res = await get("/api/browse?scope=visible");
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as BrowseResponse).collections.map((c) => c.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(unlisted.id);
    });

    // A5 (found during planning): a token-authorized anonymous listing must never mislabel a listed row
    // "public" when it is really only visible because of the token - isListedFor legitimately returns
    // null there (protection isn't public, viewer isn't owner/granted/admin), and the OLD `?? "public"`
    // fallback silently mislabeled it. The fix reuses D-103's existing "granted" case.
    describe("A5 regression: a token-authorized anonymous listing never mislabels a row 'public'", () => {
      it("labels a secret collection's own rows 'granted', never 'public', when reached only by token", async () => {
        const collection = await seedCollection({ ownerSub: "user:a", protection: "secret" });
        const file = await seedFile({ collectionId: collection.id, ownerSub: "user:a", protection: "public" });

        const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}&token=${collection.linkToken}`);
        expect(res.statusCode).toBe(200);
        const body = res.json() as BrowseResponse;
        const row = body.files.find((f) => f.id === file.id);
        expect(row?.reason).toBe("granted");
        expect(row?.reason).not.toBe("public");
      });

      it("labels a private child collection reached only by its parent's token 'granted', never 'public'", async () => {
        const parent = await seedCollection({ ownerSub: "user:a", protection: "secret" });
        const child = await seedCollection({ parentId: parent.id, ownerSub: "user:a", protection: "public" });

        const res = await get(`/api/browse?scope=visible&collectionId=${parent.id}&token=${parent.linkToken}`);
        expect(res.statusCode).toBe(200);
        const body = res.json() as BrowseResponse;
        const row = body.collections.find((c) => c.id === child.id);
        expect(row?.reason).toBe("granted");
        expect(row?.reason).not.toBe("public");
      });
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

  // A4/A7 (E4.1 live-testing findings, Wave A): the root now holds files directly (partially reverses
  // D-80) - listFilesFor's old pseudo-root short-circuit is gone.
  describe("the root now holds files directly (D-126)", () => {
    it("scope=mine at root lists the caller's own root-level files", async () => {
      const mine = await seedFile({ collectionId: "", ownerSub: "user:a", protection: "private" });
      createdRootFileIds.push(mine.id);
      const theirs = await seedFile({ collectionId: "", ownerSub: "user:b", protection: "public" });
      createdRootFileIds.push(theirs.id);
      asUser("user:a", { roles: [] });

      const res = await get("/api/browse?scope=mine", "t");
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as BrowseResponse).files.map((f) => f.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    it("anonymous scope=visible at root lists only public root-level files (never-delete, now with files present)", async () => {
      const pub = await seedFile({ collectionId: "", ownerSub: "user:a", protection: "public" });
      createdRootFileIds.push(pub.id);
      const unlisted = await seedFile({ collectionId: "", ownerSub: "user:a", protection: "unlisted" });
      createdRootFileIds.push(unlisted.id);
      const priv = await seedFile({ collectionId: "", ownerSub: "user:a", protection: "private" });
      createdRootFileIds.push(priv.id);

      const res = await get("/api/browse?scope=visible");
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as BrowseResponse).files.map((f) => f.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(unlisted.id);
      expect(ids).not.toContain(priv.id);
    });
  });

  // D-116: scope=visible is ONE contract, decided server-side from the caller's identity - the client
  // sends the same scope for every viewer. A signed-in non-admin sees public ∪ own ∪ granted; an admin
  // sees everything, because they are an admin, not because a special scope/tab exists.
  describe("scope=visible, a signed-in non-admin viewer", () => {
    it("sees their own non-public collections and public ones at root, not an unrelated stranger's non-public collection", async () => {
      const mine = await seedCollection({ ownerSub: "user:a", protection: "private", name: `mine-${randomUUID()}` });
      const pub = await seedCollection({ ownerSub: "user:stranger", protection: "public", name: `pub-${randomUUID()}` });
      const theirs = await seedCollection({ ownerSub: "user:stranger", protection: "private", name: `theirs-${randomUUID()}` });
      asUser("user:a", { roles: [] });

      const res = await get("/api/browse?scope=visible", "t");
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as BrowseResponse).collections.map((c) => c.id);
      expect(ids).toContain(mine.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(theirs.id);
    });

    it("sees a collection they hold a collection_acl grant on at root, labelled 'granted'", async () => {
      const granted = await seedCollection({ ownerSub: "user:stranger", protection: "private", name: `granted-${randomUUID()}` });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        granted.id,
        "user:a",
      ]);
      asUser("user:a", { roles: [] });

      const res = await get("/api/browse?scope=visible", "t");
      const body = res.json() as BrowseResponse;
      const row = body.collections.find((c) => c.id === granted.id);
      expect(row).toBeDefined();
      expect(row?.reason).toBe("granted");
    });
  });

  describe("scope=visible, an admin (D-101 survives as visible's admin branch)", () => {
    it("sees every collection at root, including unrelated owners' non-public ones", async () => {
      const a = await seedCollection({ ownerSub: "user:a", protection: "private" });
      const b = await seedCollection({ ownerSub: "user:b", protection: "secret" });
      asAdmin("user:admin");
      const res = await get("/api/browse?scope=visible", "t");
      const body = res.json() as BrowseResponse;
      const ids = body.collections.map((c) => c.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it("gets 200, not 404, browsing into an unrelated private collection (the scope=all replacement path)", async () => {
      const theirs = await seedCollection({ ownerSub: "user:stranger", protection: "private" });
      asAdmin("user:admin");
      expect((await get(`/api/browse?scope=visible&collectionId=${theirs.id}`, "t")).statusCode).toBe(200);
    });

    it("sees every row inside any collection, labelled 'admin' for rows they neither own nor hold a grant on", async () => {
      const theirs = await seedCollection({ ownerSub: "user:stranger", protection: "private" });
      asAdmin("user:admin");
      const res = await get("/api/browse?scope=visible", "t");
      const body = res.json() as BrowseResponse;
      expect(body.collections.find((c) => c.id === theirs.id)?.reason).toBe("admin");
    });

    it("an admin's OWN row still reports 'own', not 'admin' (own takes precedence, D-103)", async () => {
      const mine = await seedCollection({ ownerSub: "user:admin", protection: "private" });
      asAdmin("user:admin");
      const res = await get("/api/browse?scope=visible", "t");
      const body = res.json() as BrowseResponse;
      expect(body.collections.find((c) => c.id === mine.id)?.reason).toBe("own");
    });

    it("the request the client issues carries the SAME scope=visible as any other viewer (no client-side role branch)", async () => {
      const theirs = await seedCollection({ ownerSub: "user:stranger", protection: "private" });
      asAdmin("user:admin");
      // Deliberately reusing the exact same query an anonymous/non-admin viewer would send - D-116's "one
      // contract" is that the SERVER decides breadth from identity, not the client picking a different scope.
      const res = await get("/api/browse?scope=visible", "t");
      expect(res.statusCode).toBe(200);
      expect((res.json() as BrowseResponse).collections.map((c) => c.id)).toContain(theirs.id);
    });
  });

  describe("the four VisibilityReason values, and precedence (D-103)", () => {
    it("granted beats admin for a row the admin does not own but has an ACL grant on", async () => {
      const collection = await seedCollection({ ownerSub: "user:stranger", protection: "private" });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        "user:admin",
      ]);
      asAdmin("user:admin");
      const res = await get("/api/browse?scope=visible", "t");
      const body = res.json() as BrowseResponse;
      expect(body.collections.find((c) => c.id === collection.id)?.reason).toBe("granted");
    });

    it("a stranger with a file-level grant sees it via scope=visible as 'granted' (unreachable in-product until E7, directly testable - D-103)", async () => {
      const collection = await seedCollection({ ownerSub: "user:owner", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "private" });
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [file.id, "user:admin"]);
      asAdmin("user:admin");
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("granted");
    });
  });

  // E7/D-189: the fifth reason - a file another account uploaded into a collection the VIEWER owns.
  describe("the fifth VisibilityReason: 'hosted' (D-189)", () => {
    it("the collection's owner sees another account's file inside it as 'hosted', with no 500", async () => {
      const collection = await seedCollection({ ownerSub: "user:host", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:guest", protection: "private" });
      asUser("user:host");
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect(res.statusCode).toBe(200);
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("hosted");
    });

    it("an admin browsing the same page still reads 'admin', not 'hosted'", async () => {
      const collection = await seedCollection({ ownerSub: "user:host2", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:guest2", protection: "private" });
      asAdmin("user:the-admin");
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("admin");
    });

    it("the file's own uploader still sees it as 'own', not 'hosted'", async () => {
      const collection = await seedCollection({ ownerSub: "user:host3", protection: "unlisted" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:guest3", protection: "private" });
      asUser("user:guest3");
      const res = await get(`/api/browse?scope=mine`, "t");
      // scope=mine only lists what the viewer owns AT the queried collectionId; the guest's own file lives
      // inside another owner's collection, so query it directly by collectionId instead - scope=visible,
      // since scope=mine additionally requires OWNING the target collection itself (browseHandler 404s
      // otherwise).
      void res;
      const viaVisible = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      const body = viaVisible.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("own");
    });

    it("a row not hosted in the viewer's own collection is unaffected", async () => {
      const collection = await seedCollection({ ownerSub: "user:stranger-host", protection: "public" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:stranger-host", protection: "public" });
      asUser("user:someone-else");
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.files.find((f) => f.id === file.id)?.reason).toBe("public");
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

      const res = await get(`/api/browse?scope=visible&collectionId=${parent.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.collections.map((c) => c.id)).toEqual([child.id]);
      expect(body.files.map((f) => f.id)).toEqual([fileB.id, fileA.id]); // newest first
    });

    it("nextOffset is null when everything fits on one page", async () => {
      const collection = await seedCollection({ ownerSub: "user:page-small", protection: "public" });
      await seedFile({ collectionId: collection.id, ownerSub: "user:page-small", protection: "public" });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      expect((res.json() as BrowseResponse).nextOffset).toBeNull();
    });

    it("paginates at exactly 100 and 101 rows", async () => {
      const collection = await seedCollection({ ownerSub: "user:page-big", protection: "public" });
      for (let i = 0; i < 100; i++) {
        await seedFile({ collectionId: collection.id, ownerSub: "user:page-big", protection: "public", name: `n${i}.txt` });
      }
      const firstPage = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      const firstBody = firstPage.json() as BrowseResponse;
      expect(firstBody.files).toHaveLength(100);
      expect(firstBody.nextOffset).toBeNull(); // exactly 100 - nothing more

      await seedFile({ collectionId: collection.id, ownerSub: "user:page-big", protection: "public", name: "n100.txt" });
      const withExtra = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      const withExtraBody = withExtra.json() as BrowseResponse;
      expect(withExtraBody.files).toHaveLength(100);
      expect(withExtraBody.nextOffset).toBe(100);

      const secondPage = await get(`/api/browse?scope=visible&collectionId=${collection.id}&offset=100`);
      const secondBody = secondPage.json() as BrowseResponse;
      expect(secondBody.files).toHaveLength(1);
      expect(secondBody.nextOffset).toBeNull();
    }, 30_000);
  });

  describe("breadcrumb", () => {
    it("is empty at root", async () => {
      const res = await get("/api/browse?scope=visible");
      expect((res.json() as BrowseResponse).breadcrumb).toEqual([]);
    });

    it("navigates root-first into and back out of nested collections", async () => {
      const top = await seedCollection({ ownerSub: "user:crumb", protection: "public" });
      const mid = await seedCollection({ parentId: top.id, ownerSub: "user:crumb", protection: "public" });
      const deep = await seedCollection({ parentId: mid.id, ownerSub: "user:crumb", protection: "public" });

      const res = await get(`/api/browse?scope=visible&collectionId=${deep.id}`);
      const body = res.json() as BrowseResponse;
      expect(body.breadcrumb).toEqual([
        { id: top.id, name: top.name, previewUrl: expect.stringContaining(`/f/${top.name}`) },
        { id: mid.id, name: mid.name, previewUrl: expect.stringContaining(`/f/${top.name}/${mid.name}`) },
        { id: deep.id, name: deep.name, previewUrl: expect.stringContaining(`/f/${top.name}/${mid.name}/${deep.name}`) },
      ]);
    });
  });

  describe("404s rather than 500s for a nonexistent collectionId", () => {
    it.each(["mine", "visible"] as const)("scope=%s", async (scope) => {
      asAdmin("user:root");
      const res = await get(`/api/browse?scope=${scope}&collectionId=${randomUUID()}`, "t");
      expect(res.statusCode).toBe(404);
    });
  });

  // C4/C5 (E4.1 live-testing findings, Wave C): the client must not infer upload rights from the user
  // object (D-116's lesson) - the server decides and hands `canUpload` over on the browse response itself.
  describe("canUpload (Wave G's collection-page upload box depends on this)", () => {
    it("is true for an owner browsing their own collection", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      asUser("user:a", { roles: ["files:write"] });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).canUpload).toBe(true);
    });

    it("is true at the root for any files:write holder", async () => {
      asUser("user:a", { roles: ["files:write"] });
      const res = await get("/api/browse?scope=mine", "t");
      expect((res.json() as BrowseResponse).canUpload).toBe(true);
    });

    it("is false anonymously, everywhere", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const rootRes = await get("/api/browse?scope=visible");
      expect((rootRes.json() as BrowseResponse).canUpload).toBe(false);
      const collectionRes = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      expect((collectionRes.json() as BrowseResponse).canUpload).toBe(false);
    });

    it("is false in a stranger's collection the viewer cannot upload into", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "public" });
      asUser("user:stranger", { roles: ["files:write"] });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).canUpload).toBe(false);
    });

    // E7-QA1 §A2.4/H1/D-196: the case E7 shipped with NO tier asserting at all - AC3's positive case. A
    // non-owner holding a can_upload=1 ACL row, and NO files:write role, must still get canUpload: true.
    // Every existing positive test above is an owner; this is the actual invite-with-upload-rights shape.
    it("is TRUE for a non-owner with can_upload=1 and NO files:write (E7 AC3's never-asserted positive case)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        grantedSub,
      ]);
      asUser(grantedSub, { roles: [] }); // deliberately NO files:write - D-191's invite-only role
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).canUpload).toBe(true);
    });

    it("is false for the same sub with can_upload=0 (the view/upload split still holds)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        collection.id,
        grantedSub,
      ]);
      asUser(grantedSub, { roles: ["files:write"] });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).canUpload).toBe(false);
    });

    it("is false AT THE ROOT for a grant-only caller with no files:write (A2.2's root branch is unchanged)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        grantedSub,
      ]);
      asUser(grantedSub, { roles: [] });
      const res = await get("/api/browse?scope=visible", "t");
      expect((res.json() as BrowseResponse).canUpload).toBe(false);
    });
  });

  // E7-QA1 §C1 (F6): may THIS viewer SHARE the collection currently being browsed - owner or superuser
  // only (D-187), never a mere can_upload grantee. Server-decided, same pattern as canUpload.
  describe("canManage (Wave C1's collection-page Share control depends on this)", () => {
    it("is true for the owner browsing their own collection", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      asUser("user:a", { roles: ["files:write"] });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).canManage).toBe(true);
    });

    it("is true for a superuser", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      asUser("user:root", { roles: ["files:write", "files:delete"], mosni_owner: true });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      expect((res.json() as BrowseResponse).canManage).toBe(true);
    });

    it("is FALSE for a can_upload grantee (D-187: a grantee never shares, whatever canUpload says)", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "unlisted" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
        collection.id,
        grantedSub,
      ]);
      asUser(grantedSub, { roles: [] });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`, "t");
      const body = res.json() as BrowseResponse;
      expect(body.canUpload).toBe(true); // the grant IS real for upload
      expect(body.canManage).toBe(false); // but confers no sharing authority
    });

    it("is false anonymously", async () => {
      const collection = await seedCollection({ ownerSub: "user:a", protection: "public" });
      const res = await get(`/api/browse?scope=visible&collectionId=${collection.id}`);
      expect((res.json() as BrowseResponse).canManage).toBe(false);
    });

    it("is false AT THE ROOT even for a files:write holder (D-126: no single collection there to share)", async () => {
      asUser("user:a", { roles: ["files:write"] });
      const res = await get("/api/browse?scope=mine", "t");
      expect((res.json() as BrowseResponse).canManage).toBe(false);
    });
  });

  // --- Review 060/BUG-1 -------------------------------------------------------------------------------
  //
  // A `private` row's readable path RESOLVES (readablePathResolves only rejects `secret`), so this endpoint
  // handed out `dl.mosni.dev/<path>` and `dl.mosni.dev/thumb/<path>` for private files - URLs nothing in a
  // browser can authorize, because neither an <img src> nor the archive service worker's fetch() carries a
  // Bearer. The listing's thumbnails 401'd into broken images for the file's OWNER, and "Download all"
  // skipped every private file into its `failed` list. controllers/preview.ts had signed them since D-84;
  // this endpoint never did.
  describe("BUG-1: a private row's delivery URLs are D-84 signed, not bare readable paths", () => {
    it("signs directUrl and thumbUrl for a private file, and both signatures verify at their own scope", async () => {
      const collection = await seedCollection({ ownerSub: "user:owner", protection: "private" });
      const file = await seedFile({
        collectionId: collection.id,
        ownerSub: "user:owner",
        protection: "private",
        withThumb: true,
      });
      asUser("user:owner");

      const body = (await get(`/api/browse?scope=mine&collectionId=${collection.id}`, "t")).json() as BrowseResponse;
      const row = body.files.find((f) => f.id === file.id)!;

      const direct = new URL(row.directUrl);
      expect(direct.pathname).toBe(`/s/${file.id}`);
      expect(
        verifyDelivery(
          config.deliverySigningSecret,
          file.id,
          Number(direct.searchParams.get("exp")),
          direct.searchParams.get("sig")!,
          Date.now() / 1000,
          "full",
        ),
      ).toBe(true);

      const thumb = new URL(row.thumbUrl!);
      expect(thumb.pathname).toBe(`/thumb/s/${file.id}`);
      expect(
        verifyDelivery(
          config.deliverySigningSecret,
          file.id,
          Number(thumb.searchParams.get("exp")),
          thumb.searchParams.get("sig")!,
          Date.now() / 1000,
          "thumb",
        ),
      ).toBe(true);
    });

    it("a private file with no thumbnail gets a signed directUrl and a null thumbUrl", async () => {
      const collection = await seedCollection({ ownerSub: "user:owner", protection: "private" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");

      const body = (await get(`/api/browse?scope=mine&collectionId=${collection.id}`, "t")).json() as BrowseResponse;
      const row = body.files.find((f) => f.id === file.id)!;
      expect(row.directUrl).toContain("/s/");
      expect(row.thumbUrl).toBeNull();
    });

    // D-96: the EFFECTIVE level decides, never the stored column - a file stored `public` inside a
    // `private` collection is private to every reader, so its listing URLs must be signed too.
    it("signs a row that is private only by its collection's effective level (D-96)", async () => {
      const collection = await seedCollection({ ownerSub: "user:owner", protection: "private" });
      const file = await seedFile({ collectionId: collection.id, ownerSub: "user:owner", protection: "public" });
      asUser("user:owner");

      const body = (await get(`/api/browse?scope=mine&collectionId=${collection.id}`, "t")).json() as BrowseResponse;
      const row = body.files.find((f) => f.id === file.id)!;
      expect(row.effectiveProtection).toBe("private");
      expect(row.directUrl).toContain(`/s/${file.id}`);
    });

    // The other three levels are unchanged: signing them would be pointless (they need no authorization)
    // and would silently put an expiry on links people copy and keep.
    it("leaves public and unlisted rows on their bare readable path", async () => {
      const collection = await seedCollection({ ownerSub: "user:owner", protection: "public" });
      const file = await seedFile({
        collectionId: collection.id,
        ownerSub: "user:owner",
        protection: "public",
        withThumb: true,
      });
      asUser("user:owner");

      const body = (await get(`/api/browse?scope=mine&collectionId=${collection.id}`, "t")).json() as BrowseResponse;
      const row = body.files.find((f) => f.id === file.id)!;
      expect(row.directUrl).not.toContain("/s/");
      expect(row.directUrl).not.toContain("sig=");
      expect(row.thumbUrl).toContain("/thumb/");
      expect(row.thumbUrl).not.toContain("sig=");
    });
  });
});
