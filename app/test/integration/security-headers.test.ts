import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.ts";

// Mandatory, never-delete tests (verification-concept.md): each maps to a security invariant in
// technical-baseline.md §1 and must never be deleted, skipped, or weakened to make a change pass.
describe("security headers", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let redis: Redis;

  // Longer than vitest's 10s default: booting Fastify with helmet/rate-limit/static plus a real redis
  // connection is occasionally slow under the verify container's constrained resources, not a hang.
  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
    app = await buildServer(redis);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await redis.quit();
  }, 30_000);

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("sets X-Content-Type-Options: nosniff on every response (security invariant 3)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets Referrer-Policy: no-referrer on every response (security invariant 4)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("CSP allows ui.mosni.dev and auth.mosni.dev as script sources", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("https://ui.mosni.dev");
    expect(csp).toContain("https://auth.mosni.dev");
  });

  it("CSP allows dl.mosni.dev for media/img but FORBIDS it as a script source (D-4)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("dl.mosni.dev");
    expect(csp).toMatch(/img-src[^;]*dl\.mosni\.dev/);
    expect(csp).toMatch(/media-src[^;]*dl\.mosni\.dev/);
  });

  it("CSP allows auth.mosni.dev as a frame-src, unblocking the SDK's silent-refresh iframe (Wave A5)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/frame-src[^;]*https:\/\/auth\.mosni\.dev/);
  });

  it("CSP allows data:/blob: as img-src, for the drop zone's local thumbnail preview (F1)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const imgSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

    expect(imgSrc).toBeDefined();
    expect(imgSrc).toContain("data:");
    expect(imgSrc).toContain("blob:");
  });
});
