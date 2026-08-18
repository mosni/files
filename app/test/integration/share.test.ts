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
import { INVITE_DURATION_STOPS } from "../../src/lib/inviteDuration.ts";

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

  // E8/D-220: a mint fixture's expiresAt now has real consequences (Wave A enforces it in every read), so
  // a fixture that means "grants real access" must use a FUTURE timestamp - computed relative to "now"
  // rather than hardcoded, so it never goes stale the way the old fixed 2026-08-13 literal did.
  function futureIso(): string {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
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

  // E7-QA1 §A3.4/D-195: D-186's refusal is REVERSED - a grant now succeeds at every effective protection
  // level. The `409 not_private` test is REPLACED, not deleted, by these - each asserting the grant is
  // actually WRITTEN, not merely that the status is 200.
  describe("D-195: sharing succeeds at ANY effective protection level (D-186 reversed)", () => {
    it("grant on a public file succeeds and writes the ACL row", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "public" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
      expect(res.statusCode).toBe(200);
      expect(await hasAclGrant(file.id, "user:grantee")).toBe(true);
    });

    // The whole point of D-195/D-196: granting can_upload on an UNLISTED collection now does something
    // real - the view half is inert (the collection is already readable by anyone with the link), but the
    // upload half is exactly what an "invite someone to drop files in here" flow needs.
    it("grant with canUpload=true on an unlisted collection succeeds and writes a real can_upload=1 row", async () => {
      const collection = await seedCollection("user:owner", { protection: "unlisted" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", {
        token: "t",
        body: { type: "collection", id: collection.id, sub: "user:grantee", canUpload: true },
      });
      expect(res.statusCode).toBe(200);
      expect(await hasCollectionAclGrant(collection.id, "user:grantee")).toBe(true);
      const [rows] = await getPool().query("SELECT can_upload FROM collection_acl WHERE collection_id = ? AND sub = ?", [
        collection.id,
        "user:grantee",
      ]);
      expect((rows as { can_upload: number }[])[0]?.can_upload).toBe(1);
    });

    it("grant on a public collection succeeds too", async () => {
      const collection = await seedCollection("user:owner", { protection: "public" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", {
        token: "t",
        body: { type: "collection", id: collection.id, sub: "user:grantee" },
      });
      expect(res.statusCode).toBe(200);
      expect(await hasCollectionAclGrant(collection.id, "user:grantee")).toBe(true);
    });

    it("grant on a private file still succeeds, unchanged", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
      expect(res.statusCode).toBe(200);
      expect(await hasAclGrant(file.id, "user:grantee")).toBe(true);
    });

    it("a file stored unlisted inside a private collection is shareable, exactly as before (effective, not stored)", async () => {
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

    // §B1.6 needs this from the client: the picker must be able to tell whether a view grant is inert.
    // effectiveProtection stays on the response (only `shareable` was removed) precisely so it can.
    it("GET /api/shares still reports the resolved EFFECTIVE protection, never the stored column (D-96 survives D-195)", async () => {
      const collection = await seedCollection("user:owner", { protection: "public" });
      const file = await seedFile({ ownerSub: "user:owner", collectionId: collection.id, protection: "private" });
      asUser("user:owner");
      const res = await req("GET", `/api/shares?type=file&id=${file.id}`, { token: "t" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { effectiveProtection: string }).effectiveProtection).toBe("private");
      expect(res.json()).not.toHaveProperty("shareable");
    });
  });

  // E8 Wave A5 (D-219/D-220): an ordinary account share has no duration control and must write a NULL
  // expiry (AC8) - only an invite mint ever writes a real one (covered in the "invites" describe block
  // below, AC7).
  describe("ordinary account shares write a NULL expiry (D-219/D-220, AC8)", () => {
    it("POST /api/shares (file) writes expires_at NULL", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", { token: "t", body: { type: "file", id: file.id, sub: "user:grantee" } });
      expect(res.statusCode).toBe(200);
      const [rows] = await getPool().query("SELECT expires_at FROM file_acl WHERE file_id = ? AND sub = ?", [
        file.id,
        "user:grantee",
      ]);
      expect((rows as { expires_at: Date | null }[])[0]?.expires_at).toBeNull();
    });

    it("POST /api/shares (collection) writes expires_at NULL", async () => {
      const collection = await seedCollection("user:owner", { protection: "unlisted" });
      asUser("user:owner");
      const res = await req("POST", "/api/shares", {
        token: "t",
        body: { type: "collection", id: collection.id, sub: "user:grantee" },
      });
      expect(res.statusCode).toBe(200);
      const [rows] = await getPool().query(
        "SELECT expires_at FROM collection_acl WHERE collection_id = ? AND sub = ?",
        [collection.id, "user:grantee"],
      );
      expect((rows as { expires_at: Date | null }[])[0]?.expires_at).toBeNull();
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
        // E8/D-220: a FUTURE expiry - grants now expire (Wave A), so a fixture using a past date would
        // (correctly) fail hasAclGrant below rather than exercising the "grants access" path this test is
        // actually about.
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt: futureIso() },
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

    // E7-QA1 §B1.7/D-198: allow_register defaults to true when omitted, and is passed through verbatim
    // when the caller (the dialog's switch) sends it explicitly.
    it("allow_register defaults to true when the client omits it", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      const linkId = `L${randomUUID()}`;
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt: "2026-08-13T00:00:00.000Z" },
      });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(201);
      expect(mintInviteLinkMock).toHaveBeenCalledWith(expect.objectContaining({ allowRegister: true }));
    });

    it("allow_register: false from the client reaches mintInviteLink as allowRegister: false", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      const linkId = `L${randomUUID()}`;
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt: "2026-08-13T00:00:00.000Z" },
      });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, allow_register: false },
      });
      expect(res.statusCode).toBe(201);
      expect(mintInviteLinkMock).toHaveBeenCalledWith(expect.objectContaining({ allowRegister: false }));
    });

    // E8 Wave A5/A4 (D-220's whole point, AC7): the ACL row's expires_at must match auth's OWN returned
    // expiry for THIS mint - never a recomputed value - and it must be written REGARDLESS of allow_register,
    // because the switch changes who the identity is, never how long the grant lasts.
    it.each([
      ["allow_register: true", true],
      ["allow_register: false", false],
    ] as const)("invite with %s writes expires_at matching the response's expiresAt", async (_label, allowRegister) => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      const linkId = `L${randomUUID()}`;
      const expiresAt = "2026-09-01T12:34:56.000Z";
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt },
      });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, allow_register: allowRegister },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { expiresAt: string };
      expect(body.expiresAt).toBe(expiresAt);
      const [rows] = await getPool().query("SELECT expires_at FROM file_acl WHERE file_id = ? AND sub = ?", [
        file.id,
        `link:${linkId}`,
      ]);
      expect((rows as { expires_at: Date }[])[0]?.expires_at?.toISOString()).toBe(expiresAt);
    });

    it("a COLLECTION invite also writes expires_at matching the response's expiresAt", async () => {
      const collection = await seedCollection("user:owner", { protection: "unlisted" });
      const linkId = `L${randomUUID()}`;
      const expiresAt = "2026-09-01T12:34:56.000Z";
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt },
      });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "collection", id: collection.id } });
      expect(res.statusCode).toBe(201);
      const [rows] = await getPool().query(
        "SELECT expires_at FROM collection_acl WHERE collection_id = ? AND sub = ?",
        [collection.id, `link:${linkId}`],
      );
      expect((rows as { expires_at: Date }[])[0]?.expires_at?.toISOString()).toBe(expiresAt);
    });

    // E7-QA1 D-195: replaces the old "409 not_private" test - an invite for a non-private object now
    // mints and grants exactly like a private one does.
    it("invite creation succeeds for a non-private object too (D-195)", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "unlisted" });
      const linkId = `L${randomUUID()}`;
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: linkId, expiresAt: futureIso() },
      });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(201);
      expect(await hasAclGrant(file.id, `link:${linkId}`)).toBe(true);
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

  // E7-QA2 §A6: the duration slider (D-203..D-208). mintInviteLink is mocked at the top of this file, so
  // this tier can NEVER see auth's own 400 ttl_too_long - that is precisely why A3 validates in OUR
  // controller, and why Wave 0b (raising APP_LINK_TTL_MAX on the box) is a separate, box-only check. None
  // of the tests below prove the box-side cap works; they prove this app never relies on auth to catch a
  // bad value.
  describe("invite duration (E7-QA2, D-203..D-208)", () => {
    beforeEach(() => {
      mintInviteLinkMock.mockResolvedValue({
        ok: true,
        value: { url: `https://auth.mosni.dev/i/tok_${randomUUID()}`, id: `lnk_${randomUUID()}`, expiresAt: "2026-08-13T00:00:00.000Z" },
      });
    });

    it.each(INVITE_DURATION_STOPS.map((stop) => stop.seconds))(
      "a ttl_seconds of %i reaches mintInviteLink with that exact ttlSeconds",
      async (seconds) => {
        const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
        asUser("user:owner");
        const res = await req("POST", "/api/invites", {
          token: "t",
          body: { type: "file", id: file.id, ttl_seconds: seconds },
        });
        expect(res.statusCode).toBe(201);
        expect(mintInviteLinkMock).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: seconds }));
      },
    );

    it("a ttl_seconds not in the stop list is rejected 400 invalid_ttl and mints nothing", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, ttl_seconds: 12345 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_ttl" });
      expect(mintInviteLinkMock).not.toHaveBeenCalled();
    });

    it("a ttl_seconds above the top stop is rejected by US, not by auth", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, ttl_seconds: 7776001 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_ttl" });
      expect(mintInviteLinkMock).not.toHaveBeenCalled();
    });

    it("an absent ttl_seconds mints at the 1h default", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", { token: "t", body: { type: "file", id: file.id } });
      expect(res.statusCode).toBe(201);
      expect(mintInviteLinkMock).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 3600 }));
    });

    it.each([-1, 0, 1.5])("a numeric but off-list ttl_seconds (%s) is rejected 400 and mints nothing", async (bad) => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, ttl_seconds: bad },
      });
      expect(res.statusCode).toBe(400);
      expect(mintInviteLinkMock).not.toHaveBeenCalled();
    });

    it("a null ttl_seconds fails schema validation with 400", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, ttl_seconds: null as unknown as number },
      });
      expect(res.statusCode).toBe(400);
      expect(mintInviteLinkMock).not.toHaveBeenCalled();
    });

    // Fastify's default AJV runs with coerceTypes: true, so a numeric STRING that parses to one of the
    // ten stops is coerced before this app's own isValidInviteTtl ever sees it - "3600" and 3600 are
    // indistinguishable by the time either check runs. This is not a bypass (the coerced value still has
    // to match the D-204 list), just a fact worth asserting explicitly rather than assuming the plan's
    // "a string is rejected" intuition holds for every string.
    it("a numeric-string ttl_seconds that coerces to a valid stop is ACCEPTED, not rejected", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, ttl_seconds: "3600" as unknown as number },
      });
      expect(res.statusCode).toBe(201);
      expect(mintInviteLinkMock).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 3600 }));
    });

    it("a non-numeric string ttl_seconds that cannot coerce fails schema validation with 400", async () => {
      const file = await seedFile({ ownerSub: "user:owner", protection: "private" });
      asUser("user:owner");
      const res = await req("POST", "/api/invites", {
        token: "t",
        body: { type: "file", id: file.id, ttl_seconds: "not-a-number" as unknown as number },
      });
      expect(res.statusCode).toBe(400);
      expect(mintInviteLinkMock).not.toHaveBeenCalled();
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
