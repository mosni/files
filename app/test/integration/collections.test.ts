import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applySchema, closeDb, initDb } from "../../src/storage/db.ts";
import { getPool } from "../../src/storage/db.ts";
import {
  getCollectionByName,
  getOrCreateCollectionForDiskEntry,
  getOrCreateDefaultCollection,
} from "../../src/storage/collections.ts";

// Against real MariaDB (D-45) - storage/collections.ts is the only module that owns the `collections`
// table, and D-57/D-58's "first touch" and "globally unique name" claims are database behaviour, not
// pure logic.
describe("storage/collections.ts", () => {
  let root: string;
  const createdNames: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applySchema();
    root = await mkdtemp(path.join(os.tmpdir(), "collections-test-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  });

  afterEach(async () => {
    // Unique constraints (uniq_collection_name) are global across the shared test database, so every
    // test cleans up the rows it created.
    while (createdNames.length > 0) {
      const name = createdNames.pop()!;
      await getPool().query("DELETE FROM collections WHERE name = ?", [name]);
    }
  });

  function trackName(name: string): string {
    createdNames.push(name);
    return name;
  }

  describe("getOrCreateCollectionForDiskEntry() (D-57 - auto-create on first touch)", () => {
    it("returns null when neither a row nor a directory exists", async () => {
      const result = await getOrCreateCollectionForDiskEntry(root, `ghost-${randomUUID()}`);
      expect(result).toBeNull();
    });

    it("returns null for an unsafe or reserved collection name, even if a directory happens to exist", async () => {
      const result = await getOrCreateCollectionForDiskEntry(root, "f");
      expect(result).toBeNull();
    });

    it("creates an unowned, unlisted collection row on first touch of an existing bare directory", async () => {
      const name = trackName(`bare-mkdir-${randomUUID()}`);
      await mkdir(path.join(root, name));

      const created = await getOrCreateCollectionForDiskEntry(root, name);
      expect(created).not.toBeNull();
      expect(created?.ownerSub).toBeNull();
      expect(created?.protection).toBe("unlisted");
      expect(created?.isDefault).toBe(false);

      const row = await getCollectionByName(name);
      expect(row?.id).toBe(created?.id);
    });

    it("returns the existing row on a second touch rather than creating a duplicate", async () => {
      const name = trackName(`repeat-touch-${randomUUID()}`);
      await mkdir(path.join(root, name));

      const first = await getOrCreateCollectionForDiskEntry(root, name);
      const second = await getOrCreateCollectionForDiskEntry(root, name);
      expect(second?.id).toBe(first?.id);

      const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM collections WHERE name = ?", [name]);
      expect((rows as { n: number }[])[0]?.n).toBe(1);
    });
  });

  describe("getOrCreateDefaultCollection() (per-user default, D-58 suffixing)", () => {
    it("creates a default collection named from the preferred name on first upload", async () => {
      const sub = `user:${randomUUID()}`;
      const preferred = trackName(`hannah-${randomUUID()}`);

      const created = await getOrCreateDefaultCollection(sub, preferred);
      expect(created.name).toBe(preferred);
      expect(created.ownerSub).toBe(sub);
      expect(created.protection).toBe("unlisted");
      expect(created.isDefault).toBe(true);
    });

    it("returns the same default collection on a later call, rather than creating a second one", async () => {
      const sub = `user:${randomUUID()}`;
      const preferred = trackName(`repeat-default-${randomUUID()}`);

      const first = await getOrCreateDefaultCollection(sub, preferred);
      const second = await getOrCreateDefaultCollection(sub, preferred);
      expect(second.id).toBe(first.id);

      const [rows] = await getPool().query(
        "SELECT COUNT(*) AS n FROM collections WHERE owner_sub = ? AND is_default = TRUE",
        [sub],
      );
      expect((rows as { n: number }[])[0]?.n).toBe(1);
    });

    it("falls back to the sub when no preferred name is given", async () => {
      const sub = trackName(`sub-only-${randomUUID()}`);
      const created = await getOrCreateDefaultCollection(sub);
      expect(created.name).toBe(sub);
    });

    it("suffixes on a name collision (D-58 - collection names are globally unique)", async () => {
      const takenName = trackName(`taken-${randomUUID()}`);
      const subA = `user:${randomUUID()}`;
      const subB = `user:${randomUUID()}`;

      const first = await getOrCreateDefaultCollection(subA, takenName);
      expect(first.name).toBe(takenName);

      const second = await getOrCreateDefaultCollection(subB, takenName);
      trackName(second.name);
      expect(second.name).toBe(`${takenName}(2)`);
      expect(second.name).not.toBe(first.name);
    });
  });
});
