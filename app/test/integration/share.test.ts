import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));
vi.mock("../../src/auth/internalApi.ts", () => ({
  listAccounts: vi.fn(),
  setAccountRole: vi.fn(),
  mintInviteLink: vi.fn(),
}));

import { verify } from "../../src/auth/verify.ts";
import { listAccounts, mintInviteLink, setAccountRole } from "../../src/auth/internalApi.ts";
import { registerShareRoutes } from "../../src/routes/share.ts";
import { registerDeliveryRoutes } from "../../src/routes/delivery.ts";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, hasAclGrant, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection, hasCollectionAclGrant } from "../../src/storage/collections.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const verifyMock = vi.mocked(verify);
const listAccountsMock = vi.mocked(listAccounts);
const setAccountRoleMock = vi.mocked(setAccountRole);
const mintInviteLinkMock = vi.mocked(mintInviteLink);
const FILES_HOST = "files.mosni.dev";
const DL_HOST = "dl.mosni.dev";

describe("routes/share.ts + controllers/share.ts (E7 §1.4 share API)", () => {
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
    root = await mkdtemp(path.join(os.tmpdir(), "share-test-"));
    initFilesStorage(root);

    app = Fastify({ logger: false });
    const config = makeTestConfig({ storageRoot: root });
    await registerShareRoutes(app, config);
    // Registered on the SAME app so the grant->delivery->revoke round trip below can hit the real
    // delivery controller, exactly as production does (both hosts, one process, D-4 containment).
    await registerDeliveryRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  const createdCollectionIds: string[] = [];
  const createdRootFileIds: string[] = [];

  // Every handler that returns a ShareState calls listAccounts() to resolve grant names/pictures (B3) -
  // default it to an empty, successful directory so a test that does not care about the directory result
  // does not have to stub it. Tests asserting directory-specific behaviour (the 502 case, the invite tests)
  // override this per-test.
  beforeEach(() => {
    listAccountsMock.mockResolvedValue({ ok: true, value: [] });
    setAccountRoleMock.mockResolvedValue({ ok: true, value: undefined });
  });

  afterEach(async () => {
    vi.mocked(verify).mockReset();
    listAccountsMock.mockReset();
    setAccountRoleMock.mockReset();
    mintInviteLinkMock.mockReset();
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

  const req = (
    method: "GET" | "POST",
    url: string,
    opts: { token?: string; body?: Record<string, unknown>; host?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: opts.host ?? FILES_HOST,
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

  async function seedFile(opts: {
    collectionId?: string;
    name?: string;
    ownerSub?: string;
    protection?: Protection;
  }) {
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
    await writeFile(abs, "share-test-bytes");
    await commitFileRow(claimed.id, {
      bytes: 17,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
      thumbName: null,
      isText: false,
    });
    return claimed;
  }

  describe("GET /api/accounts (D-188)", () => {
    it("401s anonymously", async () => {
      expect((await req("GET", "/api/accounts")).statusCode).toBe(401);
    });

    it("403s for a valid token holding no files:write", async () => {
      asUser("user:no-write");
      expect((await req("GET", "/api/accounts", { token: "t" })).statusCode).toBe(403);
    });

    it("200s with files:write, returning auth's projection unchanged", async () => {
      asUser("user:writer", { roles: ["files:write"] });
      const accounts = [{ sub: "google:1", name: "Alice", picture: "https://auth.mosni.dev/avatar/google:1" }];
      listAccountsMock.mockResolvedValue({ ok: true, value: accounts });
      const res = await req("GET", "/api/accounts", { token: "t" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(accounts);
    });

    it("502s when auth is down", async () => {
      asUser("user:writer", { roles: ["files:write"] });
      listAccountsMock.mockResolvedValue({ ok: false, error: "auth_unreachable", status: 0 });
      const res = await req("GET", "/api/accounts", { token: "t" });
      expect(res.statusCode).toBe(502);
    });
  });

  describe("ownership gate: 404, never 403, for an object the caller does not own", () => {
    it("GET /api/shares 404s for a non-owner, and 404s for a non-existent id the same way", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:stranger");
      const owned = await req("GET", `/api/shares?type=file&id=${file.id}`, { token: "t" });
      expect(owned.statusCode).toBe(404);
      const missing = await req("GET", `/api/shares?type=file&id=${randomUUID()}`, { token: "t" });
      expect(missing.statusCode).toBe(404);
    });

    it("POST /api/shares 404s for a non-owner", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:stranger");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:x" } });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/shares/revoke 404s for a non-owner", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:stranger");
      const res = await req("POST", "/api/shares/revoke", { token: "t", body: { type: "file", id: file.id, sub: "user:x" } });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/invites 404s for a non-owner", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:stranger");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(404);
    });

    it("a mosni_owner superuser may share an object it does not own", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:root", { mosni_owner: true });
      const res = await req("GET", `/api/shares?type=file&id=${file.id}`, { token: "t" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("D-186: sharing refused unless EFFECTIVE protection is private", () => {
    it("grant on an effectively-unlisted file -> 409 not_private, and no row written", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "unlisted" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "not_private" });
      expect(await hasAclGrant(file.id, "user:grantee")).toBe(false);
    });

    it("grant on a public collection -> 409 not_private", async () => {
      const collection = await seedCollection("user:owner", { protection: "public" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", {
        token: "t",
        body: { type: "collection", id: collection.id, sub: "user:grantee" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("a file stored unlisted inside a private collection IS shareable (effective, not stored)", async () => {
      const collection = await seedCollection("user:owner", { protection: "private" });
      const file = await seedFile({ ownerSub: "user:owner", collectionId: collection.id, protection: "unlisted" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
      expect(res.statusCode).toBe(200);
      expect(await hasAclGrant(file.id, "user:grantee")).toBe(true);
    });

    it("a file stored private inside a public collection is also shareable (still effectively private)", async () => {
      const collection = await seedCollection("user:owner", { protection: "public" });
      const file = await seedFile({ ownerSub: "user:owner", collectionId: collection.id, protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("grant -> real delivery goes 403 -> 200; revoke -> 200 -> 403 again", () => {
    it("round-trips against the real delivery controller", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      listAccountsMock.mockResolvedValue({ ok: true, value: [] });
      setAccountRoleMock.mockResolvedValue({ ok: true, value: undefined });

      asUser("user:grantee");
      const before = await req("GET", `/${encodeURIComponent(file.name)}`, { token: "t", host: DL_HOST });
      expect(before.statusCode).toBe(403);

      asUser("user:owner");
      const grant = await req("POST", "/api/shares", {
        token: "t",
        body: { type: "file", id: file.id, sub: "user:grantee" },
      });
      expect(grant.statusCode).toBe(200);

      asUser("user:grantee");
      const after = await req("GET", `/${encodeURIComponent(file.name)}`, { token: "t", host: DL_HOST });
      expect(after.statusCode).toBe(200);

      asUser("user:owner");
      const revoke = await req("POST", "/api/shares/revoke", {
        token: "t",
        body: { type: "file", id: file.id, sub: "user:grantee" },
      });
      expect(revoke.statusCode).toBe(200);
      expect(setAccountRoleMock).toHaveBeenCalledWith("user:grantee", "files:read", "remove");

      asUser("user:grantee");
      const afterRevoke = await req("GET", `/${encodeURIComponent(file.name)}`, { token: "t", host: DL_HOST });
      expect(afterRevoke.statusCode).toBe(403);
    });
  });

  // 404, not 403: resolveShareTarget returns null for "not found OR not yours" so the API never confirms
  // an object exists to someone who may not share it. §1.4's table says 403 and §B1 says 404; review
  // session 045 confirmed B1 as the intended reading (it matches controllers/manage.ts's existing rule).
  it("D-187: a recipient holding a grant may not grant, revoke or invite on the same object (404)", async () => {
    const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
    await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [file.id, "user:grantee"]);
    asUser("user:grantee");
    const grant = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:third" } });
    expect(grant.statusCode).toBe(404);
    const revoke = await req("POST", "/api/shares/revoke", { token: "t", body: { type: "file", id: file.id, sub: "user:third" } });
    expect(revoke.statusCode).toBe(404);
    const invite = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
    expect(invite.statusCode).toBe(404);
  });

  it("canUpload: true on a file -> 400", async () => {
    const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
    asUser("user:owner");
    const res = await req("POST", "/api/shares", {
      token: "t",
      body: { type: "file", id: file.id, sub: "user:grantee", canUpload: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot share with self -> 400", async () => {
    const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
    asUser("user:owner");
    const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:owner" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cannot_share_with_self" });
  });

  describe("invites (D-191)", () => {
    it("mints a link, writes an ACL row against exactly link:<id>, and a token carrying that sub reads the object", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      const linkId = `lnk_${randomUUID()}`;
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt: "2026-08-13T00:00:00.000Z" },
      });

      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { url: string; expiresAt: string; sub: string };
      expect(body.sub).toBe(`link:${linkId}`);
      expect(mintInviteLinkMock).toHaveBeenCalledWith(
        expect.objectContaining({ roles: ["files:read"], destination: expect.stringContaining("files.mosni.dev") }),
      );
      expect(await hasAclGrant(file.id, `link:${linkId}`)).toBe(true);

      asUser(`link:${linkId}`);
      const delivered = await req("GET", `/${encodeURIComponent(file.name)}`, { token: "t", host: DL_HOST });
      expect(delivered.statusCode).toBe(200);
    });

    it("409 not_private if the object is not effectively private, and no link is minted", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "unlisted" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(409);
      expect(mintInviteLinkMock).not.toHaveBeenCalled();
    });

    it("passes auth's ttl_too_long through as 400", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      mintInviteLinkMock.mockResolvedValue({ ok: false, error: "ttl_too_long", status: 400 });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "ttl_too_long" });
    });

    it("502s when auth is unreachable", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      mintInviteLinkMock.mockResolvedValue({ ok: false, error: "auth_unreachable", status: 0 });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(502);
    });

    it("collection invite honours canUpload on the written grant", async () => {
      const collection = await seedCollection("user:owner", { protection: "private" });
      const linkId = `lnk_${randomUUID()}`;
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: "https://auth.mosni.dev/i/tok", id: linkId, expiresAt: "x" },
      });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "collection", id: collection.id, canUpload: true },
      });
      expect(res.statusCode).toBe(201);
      expect(await hasCollectionAclGrant(collection.id, `link:${linkId}`)).toBe(true);
    });
  });

  it("revoke calls setAccountRole exactly once and still succeeds when that call fails", async () => {
    const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
    await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [file.id, "user:grantee"]);
    setAccountRoleMock.mockResolvedValue({ ok: false, error: "auth_unreachable", status: 0 });
    listAccountsMock.mockResolvedValue({ ok: true, value: [] });

    asUser("user:owner");
    const res = await req("POST", "/api/shares/revoke", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
    expect(res.statusCode).toBe(200);
    expect(setAccountRoleMock).toHaveBeenCalledTimes(1);
    expect(await hasAclGrant(file.id, "user:grantee")).toBe(false);
  });

  // D-183's mandatory never-delete guard: files:read is registered as grantable but consulted by NO
  // authorization path. A viewer holding it (and no ACL row) must still get 403 on a private file's real
  // delivery - proven against the actual delivery controller, not by inspecting the role check in isolation.
  it("files:read grants no access on any path", async () => {
    const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
    asUser("user:has-files-read-only", { roles: ["files:read"] });
    const res = await req("GET", `/${encodeURIComponent(file.name)}`, { token: "t", host: DL_HOST });
    expect(res.statusCode).toBe(403);
  });
});
