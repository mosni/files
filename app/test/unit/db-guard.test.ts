import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/storage/db.ts";

// A dedicated file so the module's pool starts fresh (vitest isolates module state per test file) -
// schema.test.ts's beforeAll already calls initDb(), which would make this guard unreachable there.
describe("storage/db.ts - getPool() guard", () => {
  it("applyMigrations() rejects if initDb() was never called first", async () => {
    await expect(applyMigrations()).rejects.toThrow("db: initDb() must be called before applyMigrations()");
  });
});
