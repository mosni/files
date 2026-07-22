import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema, closeDb, initDb } from "../../src/storage/db.ts";
import mysql from "mysql2/promise";

const conn = () =>
  mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });

// Runs against the real MariaDB service container (D-45). Proves the "self-healing" claim - schema.sql is
// idempotent, not merely "doesn't error on a fresh DB".
describe("schema self-healing (storage/db.ts)", () => {
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
    await expect(applySchema()).resolves.toBeUndefined();
  });

  it("the files table carries the D-74 media-dimension columns", async () => {
    const c = await conn();
    try {
      const [rows] = await c.execute("DESCRIBE files");
      const columns = (rows as { Field: string }[]).map((row) => row.Field);
      expect(columns).toEqual(
        expect.arrayContaining(["width", "height", "duration_seconds", "text_preview"]),
      );
    } finally {
      await c.end();
    }
  });

  it("re-applying is a no-op - a row inserted after the first apply survives the second", async () => {
    await applySchema();
    const c = await conn();
    const filePath = `schema-test-${randomUUID()}/x.txt`;
    const token = randomUUID().replace(/-/g, "").slice(0, 5);
    try {
      await c.execute(
        "INSERT INTO files (path, bytes, protection, link_token) VALUES (?, ?, ?, ?)",
        [filePath, 1, "unlisted", token],
      );
      await applySchema(); // the actual claim: re-applying must not touch existing data
      const [rows] = await c.execute("SELECT protection FROM files WHERE path = ?", [filePath]);
      expect((rows as { protection: string }[])[0]?.protection).toBe("unlisted");
    } finally {
      await c.execute("DELETE FROM files WHERE path = ?", [filePath]);
      await c.end();
    }
  });
});
