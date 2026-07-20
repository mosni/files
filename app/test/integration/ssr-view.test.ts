import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";

// Acceptance criterion 3 / D-44: the server must actually RENDER a `.tsx` view, not merely be built from
// a toolchain that could. Node's type-stripping erases type annotations but cannot transform JSX - that
// is the entire reason this app runs built output instead of source. A suite that never renders JSX
// leaves the risk untested, and booting the built server to hit a JSON `/health` route does not touch it.
describe("SSR .tsx view rendering (D-44)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
    app = await buildServer(redis, makeTestConfig());
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await redis.quit();
  }, 30_000);

  it("renders the not-found view from .tsx source as a server-rendered HTML document", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-path" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("Not found");
  });

  it("carries the security headers on the rendered view too, not only on JSON routes", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-path" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });
});
