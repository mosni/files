import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import {
  abandonFileRow,
  claimFileRow,
  commitFileRow,
  deleteFile,
  diskRelPath,
  grantFileAcl,
  hasAclGrant,
  initFilesStorage,
  listFileGrants,
  listLinkAuthorizedFilesIn,
  listVisibleFilesIn,
  revokeFileAcl,
  renameFile,
  resolveById,
  resolveByNames,
  resolveByToken,
  resolveEffective,
  setFileProtection,
} from "../../src/storage/files.ts";
import { createCollection, setCollectionProtection } from "../../src/storage/collections.ts";
import { thumbNameFor } from "../../src/lib/thumbs.ts";
import type { Protection } from "../../src/lib/protection.ts";

// Against real MariaDB and a real temp directory. D-81/D-85: a file's identity is a surrogate id, and
// there is still no reconciliation - a row exists only because an upload claimed it, and a lookup queries
// the row and stats the one disk path it names.
describe("storage/files.ts - surrogate ids, two-phase commit (D-81/D-85)", () => {
  let root: string;
  const createdFileIds: string[] = [];
  const createdCollectionIds: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "files-test-"));
    initFilesStorage(root);
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  }, 30_000);

  afterEach(async () => {
    while (createdFileIds.length > 0) {
      const id = createdFileIds.pop()!;
      await getPool().query("DELETE FROM file_acl WHERE file_id = ?", [id]);
      await getPool().query("DELETE FROM files WHERE id = ?", [id]);
    }
    while (createdCollectionIds.length > 0) {
      await getPool().query("DELETE FROM collections WHERE id = ?", [createdCollectionIds.pop()]);
    }
  });

  async function seedCollection(ownerSub = "user:owner"): Promise<string> {
    const collection = await createCollection({
      parentId: "",
      name: `c-${randomUUID()}`,
      ownerSub,
    });
    createdCollectionIds.push(collection.id);
    return collection.id;
  }

  // Claims, moves real bytes into place, and commits - the full D-85 lifecycle a real upload performs.
  async function seedCommittedFile(opts: {
    collectionId?: string;
    name?: string;
    protection?: Protection;
    ownerSub?: string | null;
    content?: string;
  }): Promise<{ id: string; diskDir: string; diskName: string; linkToken: string }> {
    const collectionId = opts.collectionId ?? (await seedCollection());
    const name = opts.name ?? `file-${randomUUID()}.txt`;
    const content = opts.content ?? "content";
    const diskDir = "2026/07";

    const claimed = await claimFileRow({
      collectionId,
      name,
      diskDir,
      diskName: `${randomUUID()}-${name}`,
      ownerSub: opts.ownerSub === undefined ? "user:owner" : (opts.ownerSub ?? "no-owner-placeholder"),
      uploaderSub: "user:owner",
      protection: opts.protection ?? "unlisted",
      uploaderName: null,
    });
    createdFileIds.push(claimed.id);

    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);

    await commitFileRow(claimed.id, {
      bytes: content.length,
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
      thumbName: null,
      isText: false,
    });

    return { id: claimed.id, diskDir, diskName: claimed.diskName, linkToken: claimed.linkToken };
  }

  it("resolveByNames returns the record for a committed file present on disk", async () => {
    const collectionId = await seedCollection();
    const { id } = await seedCommittedFile({ collectionId, name: "photo.png", content: "abcd" });
    const collectionRow = (
      await getPool().query("SELECT name FROM collections WHERE id = ?", [collectionId])
    )[0] as { name: string }[];
    const collectionName = collectionRow[0]!.name;

    const record = await resolveByNames([collectionName, "photo.png"]);
    expect(record).toMatchObject({ id, name: "photo.png", bytes: 4, protection: "unlisted" });
    expect(record!.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);
  });

  it("resolveByNames returns null for a pending (uncommitted) row - D-85 exemption", async () => {
    const collectionId = await seedCollection();
    const claimed = await claimFileRow({
      collectionId,
      name: "still-uploading.txt",
      diskDir: "2026/07",
      diskName: `${randomUUID()}-still-uploading.txt`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "unlisted",
      uploaderName: null,
    });
    createdFileIds.push(claimed.id);

    const collectionRow = (
      await getPool().query("SELECT name FROM collections WHERE id = ?", [collectionId])
    )[0] as { name: string }[];
    expect(await resolveByNames([collectionRow[0]!.name, "still-uploading.txt"])).toBeNull();
    expect(await resolveById(claimed.id)).toBeNull();
  });

  it("resolveByNames returns null for a file whose collection segment does not exist", async () => {
    expect(await resolveByNames([`no-such-${randomUUID()}`, "x.txt"])).toBeNull();
  });

  // A3/A7 (E4.1 live-testing findings, Wave A): a single-segment path is a bare root-level filename -
  // resolveCollectionByNames([]) returns null by contract (root is not a collection row), so that lookup
  // must be skipped entirely rather than treated as a failed resolution.
  it("resolveByNames finds a root-level file from a single-segment path (D-126)", async () => {
    const name = `root-photo-${randomUUID()}.png`;
    const { id } = await seedCommittedFile({ collectionId: "", name, protection: "public" });

    const record = await resolveByNames([name]);
    expect(record).toMatchObject({ id, name, collectionId: "" });

    const resolved = await resolveEffective(record!);
    expect(resolved.effectiveProtection).toBe("public"); // no ancestor chain - its own stored level, verbatim
  });

  it("resolveByNames cleans up and returns null when the row exists but the bytes are gone (D-16)", async () => {
    const { id, diskDir, diskName } = await seedCommittedFile({});
    await unlink(path.join(root, diskDir, diskName));
    expect(await resolveById(id)).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE id = ?", [id]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByToken resolves by token, and cleans up a dead one", async () => {
    const { id, linkToken, diskDir, diskName } = await seedCommittedFile({});
    expect((await resolveByToken(linkToken))?.id).toBe(id);

    await unlink(path.join(root, diskDir, diskName));
    expect(await resolveByToken(linkToken)).toBeNull();
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE link_token = ?", [linkToken]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("resolveByToken returns null for an unknown token", async () => {
    expect(await resolveByToken("ZZZZZ")).toBeNull();
  });

  it("claimFileRow + commitFileRow records the uploader and captured media dimensions (D-74)", async () => {
    const collectionId = await seedCollection();
    const claimed = await claimFileRow({
      collectionId,
      name: "photo.png",
      diskDir: "2026/07",
      diskName: `${randomUUID()}-photo.png`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "unlisted",
      uploaderName: null,
    });
    createdFileIds.push(claimed.id);
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "hello");

    const committed = await commitFileRow(claimed.id, {
      bytes: 5,
      width: 640,
      height: 480,
      durationSeconds: 12.5,
      textPreview: null,
      thumbName: null,
      isText: false,
    });
    expect(committed.uploaderSub).toBe("user:owner");
    expect(committed.linkToken).toMatch(/^[A-Za-z0-9]{5}$/);

    const record = await resolveById(claimed.id);
    expect(record?.width).toBe(640);
    expect(record?.height).toBe(480);
    expect(record?.durationSeconds).toBe(12.5);
  });

  // D-154/D-155's `uploader_is_owner` column (and this test) is GONE - D-168 (E5.1 live-testing round 4)
  // replaced the owner-gated fallback with a provider-based one; see
  // app/test/unit/previewContext.test.ts's "uploaderName fallback (D-168)" block for that coverage now.

  it("abandonFileRow removes a pending row entirely (D-85 failure path)", async () => {
    const collectionId = await seedCollection();
    const claimed = await claimFileRow({
      collectionId,
      name: "will-fail.txt",
      diskDir: "2026/07",
      diskName: `${randomUUID()}-will-fail.txt`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "unlisted",
      uploaderName: null,
    });
    await abandonFileRow(claimed.id);
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM files WHERE id = ?", [claimed.id]);
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("renameFile is a single UPDATE and moves no bytes - the old disk name still resolves the same file", async () => {
    const { id, diskDir, diskName } = await seedCommittedFile({ name: "before.txt", content: "same-bytes" });
    await renameFile(id, "after.txt");

    const record = await resolveById(id);
    expect(record?.name).toBe("after.txt");
    expect(record?.diskDir).toBe(diskDir);
    expect(record?.diskName).toBe(diskName); // the ORIGINAL disk name, pinned forever (D-82)
  });

  it("setFileProtection changes the level without touching anything else", async () => {
    const { id } = await seedCommittedFile({ protection: "unlisted" });
    await setFileProtection(id, "private");
    expect((await resolveById(id))?.protection).toBe("private");
  });

  describe("deleteFile (D-16 hard delete: row + acl + bytes)", () => {
    it("removes the row, acl rows, and the bytes on disk", async () => {
      const { id, diskDir, diskName } = await seedCommittedFile({});
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [id, "user:granted"]);

      await deleteFile(id);

      expect(await resolveById(id)).toBeNull();
      const [aclRows] = await getPool().query("SELECT COUNT(*) AS n FROM file_acl WHERE file_id = ?", [id]);
      expect((aclRows as { n: number }[])[0]?.n).toBe(0);
      const fs = await import("node:fs/promises");
      await expect(fs.stat(path.join(root, diskDir, diskName))).rejects.toThrow();
    });

    // Review session 034: E5 (D-137) gave every image/video a SECOND on-disk artifact, and this delete
    // path was never taught about it - so each deleted image left an orphaned `<id>-thumb.webp` behind
    // forever, quietly falsifying D-16's "row + acl + bytes". Not a serving leak (with the row gone,
    // nothing can hand nginx an X-Accel-Redirect for it) but unbounded dead disk on a box with little.
    it("removes the thumbnail as well as the source bytes (D-137)", async () => {
      const { id, diskDir } = await seedCommittedFile({ name: "shot.jpg" });
      const thumbName = thumbNameFor(id);
      await getPool().query("UPDATE files SET thumb_name = ? WHERE id = ?", [thumbName, id]);
      const thumbAbs = path.join(root, diskDir, thumbName);
      await writeFile(thumbAbs, "thumb-bytes");

      await deleteFile(id);

      const fs = await import("node:fs/promises");
      await expect(fs.stat(thumbAbs)).rejects.toThrow();
    });

    it("is idempotent - deleting an already-gone id does nothing and does not throw", async () => {
      await expect(deleteFile(`nonexistent${randomUUID()}`.replace(/-/g, "").slice(0, 16))).resolves.toBeUndefined();
    });
  });

  // D-96: the landmine. A row's stored `protection` is never safe to read directly - resolveEffective()
  // folds the collection's ancestor chain together with the file's own stored level via
  // lib/protection.ts's mostRestrictive(), and every read path must use ITS result, never record.protection.
  describe("resolveEffective (D-96 - effective protection)", () => {
    it("a public file in an unlisted collection is EFFECTIVELY unlisted, not public", async () => {
      const collectionId = await seedCollection();
      const { id } = await seedCommittedFile({ collectionId, protection: "public" });
      const record = await resolveById(id);
      const resolved = await resolveEffective(record!);
      expect(resolved.protection).toBe("public"); // the STORED value, untouched
      expect(resolved.effectiveProtection).toBe("unlisted"); // the collection is more restrictive
    });

    it("a public file in a public collection is effectively public", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `eff-public-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      createdCollectionIds.push(collection.id);
      const { id } = await seedCommittedFile({ collectionId: collection.id, protection: "public" });
      const resolved = await resolveEffective((await resolveById(id))!);
      expect(resolved.effectiveProtection).toBe("public");
    });

    it("raising the collection's protection is reflected immediately, with no rewrite of the file's own stored level", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `eff-raise-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "unlisted",
      });
      createdCollectionIds.push(collection.id);
      const { id } = await seedCommittedFile({ collectionId: collection.id, protection: "unlisted" });

      await setCollectionProtection(collection.id, "private");
      const raised = await resolveEffective((await resolveById(id))!);
      expect(raised.effectiveProtection).toBe("private");
      expect(raised.protection).toBe("unlisted"); // D-97: the file's own row is untouched

      // Lowering it again restores the previous per-file behaviour exactly.
      await setCollectionProtection(collection.id, "unlisted");
      const lowered = await resolveEffective((await resolveById(id))!);
      expect(lowered.effectiveProtection).toBe("unlisted");
    });

    it("the file's own level can be the most restrictive one in the chain", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `eff-file-strictest-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      createdCollectionIds.push(collection.id);
      const { id } = await seedCommittedFile({ collectionId: collection.id, protection: "private" });
      const resolved = await resolveEffective((await resolveById(id))!);
      expect(resolved.effectiveProtection).toBe("private");
    });
  });

  describe("hasAclGrant (security invariant 6 - byte-for-byte, never parsed)", () => {
    it("matches only the exact sub granted", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const grantedSub = `user:${randomUUID()}`;
      await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [id, grantedSub]);

      expect(await hasAclGrant(id, grantedSub)).toBe(true);
      expect(await hasAclGrant(id, grantedSub.slice(0, -1))).toBe(false);
      expect(await hasAclGrant(id, `${grantedSub}x`)).toBe(false);
    });

    it("returns false when no grant exists", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      expect(await hasAclGrant(id, `user:${randomUUID()}`)).toBe(false);
    });
  });

  // E7 Wave A1: the write half of file_acl (grantFileAcl/revokeFileAcl/listFileGrants).
  // controllers/share.ts is the only authorization-aware caller; this suite only proves the plain SQL
  // semantics, including the invariant-6 adversarial round trips.
  describe("grantFileAcl / revokeFileAcl / listFileGrants (E7)", () => {
    it("grant makes hasAclGrant true; revoke makes it false again", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const sub = `user:${randomUUID()}`;

      expect(await hasAclGrant(id, sub)).toBe(false);
      await grantFileAcl(id, sub);
      expect(await hasAclGrant(id, sub)).toBe(true);
      await revokeFileAcl(id, sub);
      expect(await hasAclGrant(id, sub)).toBe(false);
    });

    it("granting the same sub twice is idempotent - still exactly one row, never throws", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const sub = `user:${randomUUID()}`;

      await grantFileAcl(id, sub);
      await expect(grantFileAcl(id, sub)).resolves.toBeUndefined();
      expect(await listFileGrants(id)).toEqual([sub]);
    });

    it("listFileGrants returns every granted sub, sorted", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const subB = "user:bbbb";
      const subA = "user:aaaa";
      await grantFileAcl(id, subB);
      await grantFileAcl(id, subA);
      expect(await listFileGrants(id)).toEqual([subA, subB]);
    });

    it("revoking a sub that was never granted is a no-op, never throws", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      await expect(revokeFileAcl(id, `user:${randomUUID()}`)).resolves.toBeUndefined();
    });

    // Invariant 6 is about never PARSING a sub (no LIKE, no SUBSTRING, no split) - these are adversarial
    // shapes for that, stored and read back exactly as given.
    it.each([
      ["a sub containing a colon (D-191's link:<id> shape)", `link:${randomUUID()}`],
      ["a sub with a trailing space", "user:trailing-space "],
      ["a 255-char sub", `user:${"x".repeat(250)}`],
    ] as const)("round-trips %s byte-for-byte", async (_label, sub) => {
      const { id } = await seedCommittedFile({ protection: "private" });
      await grantFileAcl(id, sub);
      expect(await hasAclGrant(id, sub)).toBe(true);
      expect(await listFileGrants(id)).toEqual([sub]);
    });

    // Review session 045: the round trips above only prove a sub matches ITSELF - which passed even while
    // the column collated case/accent/space-insensitively (migration 008). The load-bearing half of
    // invariant 6 is the NEGATIVE: a sub that is not byte-identical must not match. `hasAclGrant` is what
    // authorizePrivate calls, so a fold here is an authorization decision, not a cosmetic one.
    it.each([
      ["differing only in case", "user:byte-exact", "USER:BYTE-EXACT"],
      ["differing only by a trailing space", "user:byte-exact", "user:byte-exact "],
      ["differing only by an accent", "user:byte-exact", "user:byté-exact"],
      ["a prefix of the granted sub", "user:byte-exact", "user:byte"],
    ] as const)("a sub %s does NOT match the granted row", async (_label, granted, probe) => {
      const { id } = await seedCommittedFile({ protection: "private" });
      await grantFileAcl(id, granted);
      expect(await hasAclGrant(id, probe)).toBe(false);
    });

    it("two subs differing only in case are two distinct grants, not one", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      await grantFileAcl(id, "user:Case");
      await grantFileAcl(id, "user:case");
      expect((await listFileGrants(id)).sort()).toEqual(["user:Case", "user:case"].sort());
      await revokeFileAcl(id, "user:case");
      expect(await hasAclGrant(id, "user:Case")).toBe(true);
    });
  });

  // E8 Wave A5 (D-219/D-220): expiry enforcement on every file-side ACL read. Each assertion below asserts
  // an ABSENCE of access and was run RED against the pre-Wave-A predicates before FILE_GRANT_LIVE was
  // appended - a never-ran-red assertion proves nothing (see the hand-off's own warning on this wave).
  describe("expiry enforcement (D-219/D-220, E8)", () => {
    function pastDate(): Date {
      return new Date(Date.now() - 60_000);
    }
    function futureDate(): Date {
      return new Date(Date.now() + 60_000);
    }

    it("granted_at is populated automatically on insert", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(id, sub);
      const [rows] = await getPool().query("SELECT granted_at FROM file_acl WHERE file_id = ? AND sub = ?", [
        id,
        sub,
      ]);
      expect((rows as { granted_at: Date }[])[0]?.granted_at).toBeInstanceOf(Date);
    });

    it("hasAclGrant: an EXPIRED grant does NOT authorize", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(id, sub, pastDate());
      expect(await hasAclGrant(id, sub)).toBe(false);
    });

    it("hasAclGrant: a NULL expiry authorizes (the ordinary-share case)", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(id, sub, null);
      expect(await hasAclGrant(id, sub)).toBe(true);
    });

    it("hasAclGrant: a FUTURE expiry authorizes", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(id, sub, futureDate());
      expect(await hasAclGrant(id, sub)).toBe(true);
    });

    it("listFileGrants omits an EXPIRED grant", async () => {
      const { id } = await seedCommittedFile({ protection: "private" });
      await grantFileAcl(id, "user:live", futureDate());
      await grantFileAcl(id, "user:dead", pastDate());
      expect(await listFileGrants(id)).toEqual(["user:live"]);
    });

    it("listVisibleFilesIn omits a file reachable only via an EXPIRED file_acl grant", async () => {
      const collectionId = await seedCollection();
      const { id } = await seedCommittedFile({ collectionId, protection: "private", ownerSub: "user:owner" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(id, sub, pastDate());
      const ids = (await listVisibleFilesIn(collectionId, sub)).map((f) => f.id);
      expect(ids).not.toContain(id);
    });

    it("listLinkAuthorizedFilesIn omits a file reachable only via an EXPIRED file_acl grant", async () => {
      const collectionId = await seedCollection();
      const { id } = await seedCommittedFile({ collectionId, protection: "private", ownerSub: "user:owner" });
      const sub = `user:${randomUUID()}`;
      await grantFileAcl(id, sub, pastDate());
      const ids = (await listLinkAuthorizedFilesIn(collectionId, sub)).map((f) => f.id);
      expect(ids).not.toContain(id);
    });
  });

  // Review session 017 - acceptance criterion 11: "Two CONCURRENT same-named uploads into one collection
  // produce two distinct files." The suffixing used to happen in controllers/upload.ts, against a sibling
  // list read BEFORE the insert: two uploads in flight at once both read the same list, both picked the
  // same name, and the second one's INSERT died on uniq_name_in_collection. Resolving the collision inside
  // claimFileRow - at the insert that actually detects it - is what makes the criterion hold.
  describe("claimFileRow display-name collisions (AC11)", () => {
    it("suffixes a sequential same-name claim", async () => {
      const collectionId = await seedCollection();
      const first = await claim(collectionId, "dup.txt");
      const second = await claim(collectionId, "dup.txt");
      expect(first.name).toBe("dup.txt");
      expect(second.name).toBe("dup(2).txt");
    });

    it("resolves CONCURRENT same-name claims into two distinct rows", async () => {
      const collectionId = await seedCollection();
      const claimed = await Promise.all([
        claim(collectionId, "race.txt"),
        claim(collectionId, "race.txt"),
        claim(collectionId, "race.txt"),
      ]);

      const names = claimed.map((c) => c.name).sort();
      const ids = new Set(claimed.map((c) => c.id));
      expect(ids.size).toBe(3);
      expect(new Set(names).size).toBe(3); // no two rows share a display name
      expect(names).toContain("race.txt");
      // The suffix is never applied twice over ("race(2)(2).txt") - it is always recomputed from the
      // originally requested name.
      for (const name of names) expect(name).toMatch(/^race(\(\d+\))?\.txt$/);
    });

    async function claim(collectionId: string, name: string) {
      const claimed = await claimFileRow({
        collectionId,
        name,
        diskDir: "2026/07",
        diskName: `${randomUUID()}-${name}`,
        ownerSub: "user:owner",
        uploaderSub: "user:owner",
        protection: "unlisted",
        uploaderName: null,
      });
      createdFileIds.push(claimed.id);
      return claimed;
    }
  });
});
