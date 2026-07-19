import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema, closeDb, initDb } from "../../src/storage/db.ts";
import mysql from "mysql2/promise";

// Integration suite: runs against the real MariaDB service container from docker-compose.verify.yml
// (D-45). Proves the actual "self-healing" claim - schema.sql is idempotent, not merely "doesn't error
// on a fresh DB".
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

  it("applies cleanly against a blank database", async () => {
    await expect(applySchema()).resolves.toBeUndefined();
  });

  it("re-applying is a no-op - a row inserted after the first apply survives the second", async () => {
    await applySchema();

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    const id = randomUUID();
    try {
      await conn.execute(
        "INSERT INTO collections (id, owner_sub, name, is_default) VALUES (?, ?, ?, ?)",
        [id, "user:test", "test-collection", false],
      );

      await applySchema(); // the actual claim under test: re-applying must not touch existing data

      const [rows] = await conn.execute("SELECT name FROM collections WHERE id = ?", [id]);
      expect((rows as { name: string }[])[0]?.name).toBe("test-collection");
    } finally {
      await conn.execute("DELETE FROM collections WHERE id = ?", [id]);
      await conn.end();
    }
  });
});
