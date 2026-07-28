import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, closeDb, initDb } from "../../src/storage/db.ts";
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
      await c.execute(
        "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection) VALUES (?, '', ?, 'user:test', 'unlisted')",
        [collectionId, `schema-test-${randomUUID()}`],
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
});
