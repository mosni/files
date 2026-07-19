import { afterAll, describe, expect, it } from "vitest";
import { start } from "../../src/server.ts";
import { closeDb } from "../../src/storage/db.ts";
import { closeRedis } from "../../src/storage/redis.ts";

// The real boot sequence, against the real MariaDB/redis service containers (D-45). BOT_API/AUTH_ISSUER
// point at hosts that don't exist in this compose network - proving registerGrantableRoles() (D-32) and
// the applySchema() try/catch (also D-32-style) really are non-fatal, not just non-fatal in a mock.
describe("start()", () => {
  let app: Awaited<ReturnType<typeof start>>;

  afterAll(async () => {
    await app?.close();
    await closeDb();
    await closeRedis();
  }, 30_000);

  it("boots and listens even with an unreachable auth", async () => {
    app = await start();
    expect(app.server.listening).toBe(true);
  }, 30_000);
});
