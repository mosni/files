// E6 A3/A3b (D-180) - the write and delivery rate-limit namespaces, and the one thing the plan's own
// acceptance criterion 26 actually claims: exhausting one does NOT consume the global budget, and the
// global 100/min cap does not silently keep applying underneath.
//
// This test exists because the E6 review session (042) found that it did. The upload limiter's own
// isolation test (upload.test.ts) registered NO global limiter at all, so it passed against a server that
// could not have exhibited the bug; wired the way server.ts actually wires it, a nested
// `register(rateLimit, …)` scope ADDS a second limiter rather than replacing the global one, and the
// stricter global cap won (first 429 at request #101). Every assertion below is one that failed before
// the routes moved to per-route `config.rateLimit`.
//
// Each case uses its own `remoteAddress` and/or bearer so the Redis counters can never be inherited from
// another test file sharing this container's IP.
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { registerDeliveryRoutes } from "../../src/routes/delivery.ts";
import { registerManageRoutes } from "../../src/routes/manage.ts";
import { registerMetaRoutes } from "../../src/routes/meta.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";

const FILES_HOST = "files.mosni.dev";
const DL_HOST = "dl.mosni.dev";
const GLOBAL_MAX = 100;

describe("rate-limit namespaces (D-180)", () => {
  let app: FastifyInstance;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
    const config = makeTestConfig({ storageRoot: "/tmp" });
    app = Fastify({ logger: false });
    // Mirrors server.ts exactly: the global limiter registered on the ROOT instance, then the route
    // modules. Registering the routes without it is what made the original isolation test vacuous.
    await app.register(rateLimit, {
      redis,
      global: true,
      max: GLOBAL_MAX,
      timeWindow: "1 minute",
      nameSpace: "fastify-rate-limit-global-",
    });
    await registerMetaRoutes(app, config);
    await registerManageRoutes(app, config);
    await registerDeliveryRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await redis.quit();
  }, 30_000);

  function unique(): string {
    return `rl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  it("the management API answers well past the global 100/min cap (a folder drop's collection creation)", async () => {
    const bearer = `Bearer ${unique()}`;
    const ip = "10.10.0.1";
    let limited = 0;
    for (let i = 0; i < GLOBAL_MAX + 50; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/collections",
        remoteAddress: ip,
        headers: { host: FILES_HOST, authorization: bearer },
      });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBe(0);
  }, 60_000);

  it("delivery answers well past the global cap (a listing of >100 thumbnail rows)", async () => {
    const ip = "10.10.0.2";
    let limited = 0;
    for (let i = 0; i < GLOBAL_MAX + 50; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/thumb/t/${unique()}`,
        remoteAddress: ip,
        headers: { host: DL_HOST },
      });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBe(0);
  }, 60_000);

  it("exhausting the write namespace 429s writes but leaves the global budget untouched", async () => {
    const bearer = `Bearer ${unique()}`;
    const ip = "10.10.0.3";
    let lastStatus = 0;
    for (let i = 0; i < 305; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/collections",
        remoteAddress: ip,
        headers: { host: FILES_HOST, authorization: bearer },
      });
      lastStatus = res.statusCode;
    }
    // Past its own 300/min ceiling the write namespace does limit - it is a real limiter, not an opt-out.
    expect(lastStatus).toBe(429);

    // ...and a globally-limited route from the SAME client is still served: those 305 requests never
    // touched the global counter. Before the fix this assertion was unreachable, because the write calls
    // were counted against the global budget and 429'd at 101.
    const globalRoute = await app.inject({
      method: "GET",
      url: "/api/config",
      remoteAddress: ip,
      headers: { host: FILES_HOST },
    });
    expect(globalRoute.statusCode).toBe(200);
  }, 90_000);

  it("exhausting the write namespace does not consume delivery's budget either", async () => {
    const bearer = `Bearer ${unique()}`;
    const ip = "10.10.0.4";
    for (let i = 0; i < 305; i++) {
      await app.inject({
        method: "PATCH",
        url: "/api/files/does-not-exist",
        remoteAddress: ip,
        headers: { host: FILES_HOST, authorization: bearer, "content-type": "application/json" },
        payload: { name: "x.txt" },
      });
    }
    const delivery = await app.inject({
      method: "GET",
      url: `/thumb/t/${unique()}`,
      remoteAddress: ip,
      headers: { host: DL_HOST },
    });
    expect(delivery.statusCode).not.toBe(429);
  }, 90_000);
});
