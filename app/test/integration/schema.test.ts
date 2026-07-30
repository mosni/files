import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  backfillCollectionLinkTokens,
  closeDb,
  initDb,
  isLinkTokenTaken,
} from "../../src/storage/db.ts";
import mysql from "mysql2/promise";

const conn = () =>
  mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });

// Runs against the real MariaDB service container (D-45). Proves the migration mechanism's actual claims
// (D-83): applying twice is a no-op, schema_version tracks what has run, and E3's new tables exist with
// the columns §1.2 of the waves hand-off specifies.
describe("numbered migrations (storage/db.ts, D-83)", () => {
  beforeAll(() => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("applies cleanly against a database", async () => {
    await expect(applyMigrations()).resolves.toBeUndefined();
  });

  it("records every migration version in schema_version", async () => {
    const c = await conn();
    try {
      const [rows] = await c.execute("SELECT version FROM schema_version ORDER BY version");
      const versions = (rows as { version: number }[]).map((row) => row.version);
      expect(versions).toEqual(expect.arrayContaining([1, 2]));
    } finally {
      await c.end();
    }
  });

  it("the files table carries the E3 surrogate-id shape (id, collection_id, disk_dir, disk_name, state)", async () => {
    const c = await conn();
    try {
      const [rows] = await c.execute("DESCRIBE files");
      const columns = (rows as { Field: string }[]).map((row) => row.Field);
      expect(columns).toEqual(
        expect.arrayContaining([
          "id",
          "collection_id",
          "name",
          "disk_dir",
          "disk_name",
          "state",
          "width",
          "height",
          "duration_seconds",
          "text_preview",
        ]),
      );
      expect(columns).not.toContain("path");
    } finally {
      await c.end();
    }
  });

  it("collections, file_acl (re-keyed) and collection_acl all exist with the §1.2 shape", async () => {
    const c = await conn();
    try {
      const [collectionsRows] = await c.execute("DESCRIBE collections");
      expect((collectionsRows as { Field: string }[]).map((r) => r.Field)).toEqual(
        expect.arrayContaining(["id", "parent_id", "name", "owner_sub", "default_protection"]),
      );

      const [aclRows] = await c.execute("DESCRIBE file_acl");
      const aclColumns = (aclRows as { Field: string }[]).map((r) => r.Field);
      expect(aclColumns).toEqual(expect.arrayContaining(["file_id", "sub"]));
      expect(aclColumns).not.toContain("path");

      const [collectionAclRows] = await c.execute("DESCRIBE collection_acl");
      expect((collectionAclRows as { Field: string }[]).map((r) => r.Field)).toEqual(
        expect.arrayContaining(["collection_id", "sub", "can_upload"]),
      );
    } finally {
      await c.end();
    }
  });

  it("re-applying is a no-op - a row inserted after the first apply survives the second", async () => {
    await applyMigrations();
    const c = await conn();
    const collectionId = randomUUID().replace(/-/g, "").slice(0, 16);
    try {
      // link_token given explicitly (D-98's unique index means the column's own DEFAULT '' can only ever
      // be held by one row across the whole shared test database at a time - every seeded row here must
      // carry its own real value rather than leaning on the default).
      await c.execute(
        "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection, link_token) VALUES (?, '', ?, 'user:test', 'unlisted', ?)",
        [collectionId, `schema-test-${randomUUID()}`, randomUUID().replace(/-/g, "").slice(0, 5)],
      );
      await applyMigrations(); // the actual claim: re-applying must not touch existing data
      const [rows] = await c.execute("SELECT default_protection FROM collections WHERE id = ?", [
        collectionId,
      ]);
      expect((rows as { default_protection: string }[])[0]?.default_protection).toBe("unlisted");
    } finally {
      await c.execute("DELETE FROM collections WHERE id = ?", [collectionId]);
      await c.end();
    }
  });

  it("records version 3 in schema_version", async () => {
    const c = await conn();
    try {
      const [rows] = await c.execute("SELECT version FROM schema_version ORDER BY version");
      const versions = (rows as { version: number }[]).map((row) => row.version);
      expect(versions).toEqual(expect.arrayContaining([1, 2, 3]));
    } finally {
      await c.end();
    }
  });

  it("collections carries protection and link_token (D-95/D-98), each a distinct column from default_protection", async () => {
    const c = await conn();
    try {
      const [rows] = await c.execute("DESCRIBE collections");
      const columns = (rows as { Field: string }[]).map((row) => row.Field);
      expect(columns).toEqual(expect.arrayContaining(["protection", "default_protection", "link_token"]));
    } finally {
      await c.end();
    }
  });
});

// Wave 0.2: the migration itself only ADDs the columns (link_token defaulting to '' for every existing
// row) - it is storage/db.ts's backfillCollectionLinkTokens() that must give each pre-existing row a
// real, cross-table-unique token before the unique index can hold. Tested directly (rather than only via
// the one-shot applyMigrations() path) against a database seeded with several collections, since an empty
// database would never exercise the backfill loop at all.
describe("backfillCollectionLinkTokens (§1.1/§1.2 of the E4 waves hand-off)", () => {
  let c: mysql.Connection;
  const seededIds: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    c = await conn();
  }, 30_000);

  afterAll(async () => {
    await c.end();
    await closeDb();
  }, 30_000);

  afterEach(async () => {
    while (seededIds.length > 0) {
      const id = seededIds.pop()!;
      await c.execute("DELETE FROM collections WHERE id = ?", [id]);
    }
  });

  // Only ONE row anywhere in this shared database can hold the column's raw DEFAULT '' at a time once
  // the unique index exists - exactly the constraint the real migration works around by backfilling
  // BEFORE creating the index. To prove backfillCollectionLinkTokens against several such rows at once
  // (not just one), this drops the index under the same advisory lock applyMigrations() itself uses
  // (so it cannot race a concurrent first-time migration run), seeds, then lets backfillCollectionLinkTokens
  // recreate the index before releasing the lock.
  async function withTemporarilyDroppedIndex<T>(work: () => Promise<T>): Promise<T> {
    const [lockRows] = await c.query<(mysql.RowDataPacket & { acquired: number })[]>(
      "SELECT GET_LOCK('files_schema_migrations', 30) AS acquired",
    );
    if (lockRows[0]?.acquired !== 1) {
      throw new Error("test could not acquire the files_schema_migrations lock");
    }
    try {
      await c.query("DROP INDEX IF EXISTS uniq_collection_link_token ON collections");
      return await work();
    } finally {
      await c.query("SELECT RELEASE_LOCK('files_schema_migrations')");
    }
  }

  async function seedEmptyToken(): Promise<string> {
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    seededIds.push(id);
    // link_token omitted entirely - takes the column's own DEFAULT '', exactly what a pre-E4 row (or a
    // row inserted between the ALTER and the backfill) looks like.
    await c.execute(
      "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection) VALUES (?, '', ?, 'user:test', 'unlisted')",
      [id, `backfill-${randomUUID()}`],
    );
    return id;
  }

  it("gives every empty-token row a distinct, well-shaped token", async () => {
    const ids = await withTemporarilyDroppedIndex(async () => {
      const collected = [await seedEmptyToken(), await seedEmptyToken(), await seedEmptyToken()];
      await backfillCollectionLinkTokens(c); // recreates the index before this returns
      return collected;
    });

    const [rows] = await c.execute(
      `SELECT id, link_token FROM collections WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    const tokens = (rows as { id: string; link_token: string }[]).map((row) => row.link_token);
    expect(tokens).toHaveLength(3);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(new Set(tokens).size).toBe(3); // no two backfilled rows share a token
  });

  it("is idempotent - a row that already has a token is left untouched", async () => {
    const id = await seedEmptyToken();
    await backfillCollectionLinkTokens(c);
    const [firstPass] = await c.execute("SELECT link_token FROM collections WHERE id = ?", [id]);
    const firstToken = (firstPass as { link_token: string }[])[0]!.link_token;

    await backfillCollectionLinkTokens(c); // must be a no-op for rows that already have a token
    const [secondPass] = await c.execute("SELECT link_token FROM collections WHERE id = ?", [id]);
    expect((secondPass as { link_token: string }[])[0]!.link_token).toBe(firstToken);
  });

  it("the unique index rejects a manual duplicate token across two collections", async () => {
    await backfillCollectionLinkTokens(c); // ensure the index exists before probing it
    const idA = randomUUID().replace(/-/g, "").slice(0, 16);
    const idB = randomUUID().replace(/-/g, "").slice(0, 16);
    seededIds.push(idA, idB);
    await c.execute(
      "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection, link_token) VALUES (?, '', ?, 'user:test', 'unlisted', 'ZZZZZ')",
      [idA, `dup-token-${randomUUID()}`],
    );
    await expect(
      c.execute(
        "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection, link_token) VALUES (?, '', ?, 'user:test', 'unlisted', 'ZZZZZ')",
        [idB, `dup-token-${randomUUID()}`],
      ),
    ).rejects.toThrow();
  });

  it("isLinkTokenTaken() sees a token from either table", async () => {
    const id = await seedEmptyToken();
    await backfillCollectionLinkTokens(c);
    const [rows] = await c.execute("SELECT link_token FROM collections WHERE id = ?", [id]);
    const token = (rows as { link_token: string }[])[0]!.link_token;

    expect(await isLinkTokenTaken(c, token)).toBe(true);
    expect(await isLinkTokenTaken(c, "NOPE0")).toBe(false);
  });
});
