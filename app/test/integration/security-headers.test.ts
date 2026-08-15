import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import { UPLOAD_CHUNK_SIZE, UPLOAD_EXPIRY_MS } from "../../src/lib/uploadConfig.ts";

// Mandatory, never-delete tests (verification-concept.md): each maps to a security invariant in
// technical-baseline.md §1 and must never be deleted, skipped, or weakened to make a change pass.
describe("security headers", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let redis: Redis;

  // Longer than vitest's 10s default: booting Fastify with helmet/rate-limit/static plus a real redis
  // connection is occasionally slow under the verify container's constrained resources, not a hang.
  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
    app = await buildServer(redis, makeTestConfig());
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

  it("CSP allows dl.mosni.dev as a frame-src (D-70 Wave C5 bug fix) but still forbids it as script-src", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const frameSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src"));
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));

    expect(frameSrc).toContain("https://dl.mosni.dev");
    expect(scriptSrc).not.toContain("dl.mosni.dev");
  });

  it("CSP allows files.mosni.dev as a frame-ancestor (D-70 e2e finding), so dl.'s own response can be framed by a preview page", async () => {
    // helmet is registered once, globally - dl.'s delivery responses carry the exact same CSP as files.'s
    // pages, including frame-ancestors. Wave C5's frame-src fix alone was never sufficient: frame-src
    // governs what the PARENT may embed, frame-ancestors governs whether the CHILD allows being embedded -
    // both must permit it, or a dl. iframe embedded from a preview page is blocked in production too.
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const frameAncestors = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors"));
    expect(frameAncestors).toContain("https://files.mosni.dev");
  });

  // D-135 (E5): the client-side archive feature (D-133) needs to fetch() file bytes cross-origin from
  // dl.mosni.dev. connect-src governs where our JS may READ from; script-src would govern EXECUTION - that
  // distinction is the security boundary, so dl. must join the former and never the latter.
  it("CSP allows dl.mosni.dev as a connect-src (D-135) but still forbids it as script-src", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const connectSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src"));
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));

    expect(connectSrc).toBeDefined();
    expect(connectSrc).toContain("https://dl.mosni.dev");
    expect(scriptSrc).not.toContain("dl.mosni.dev");
  });

  it("CSP allows data:/blob: as img-src, for the drop zone's local thumbnail preview (F1)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const imgSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

    expect(imgSrc).toBeDefined();
    expect(imgSrc).toContain("data:");
    expect(imgSrc).toContain("blob:");
  });

  // Review session 052, F3's real root cause. Allow-listing `auth.mosni.dev` looks like it covers the
  // avatar, and does not: `GET auth.mosni.dev/avatar/<sub>` is a **302**, and img-src is enforced against
  // the FINAL url. A Google account lands on Google's CDN and an EVE one on images.evetech.net, so both
  // were blocked while the owner (redirected to mosni.dev, already allowed) and every account with no
  // stored picture (an inline SVG from auth itself) worked - which is exactly why this survived two
  // rounds of "the avatars still don't load". Deleting either origin re-breaks real photos in the share
  // dialog's picker and the preview byline.
  it("CSP allows the IdP CDNs auth's /avatar/<sub> REDIRECTS to, not just auth's own origin", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const imgSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

    expect(imgSrc).toBeDefined();
    expect(imgSrc).toContain("https://auth.mosni.dev");
    expect(imgSrc).toContain("https://lh3.googleusercontent.com");
    expect(imgSrc).toContain("https://images.evetech.net");
    // Named origins only - a wildcard here would let any redirect target through.
    expect(imgSrc).not.toContain("*");
  });

  // Regression guard: <mosni-logo> inside <mosni-header> loads mosni.svg from the design system's own
  // origin, so omitting it here makes the site logo a broken image on every page (found by D-79's
  // visual check, after session 009 mistook the console warning for unrelated noise).
  it("CSP allows ui.mosni.dev as an img-src, so the chrome's own logo is not blocked", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const imgSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

    expect(imgSrc).toContain("https://ui.mosni.dev");
  });

  // mosnicat.js hard-codes a favicon <link rel="icon" href="https://mosni.dev/images/icon.png"> on every
  // page; favicons are governed by img-src, so omitting the apex 404s the favicon under our own CSP.
  // Reported from the deployed app.
  it("CSP allows the mosni.dev apex as an img-src, so the chrome's favicon is not blocked", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const imgSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

    expect(imgSrc).toContain("https://mosni.dev");
  });

  // D-169: the uploader avatar <img src> now points straight at auth.mosni.dev/avatar/<sub> (no more
  // files.-side proxy) - omitting it here silently blocks every avatar image under this CSP. Reported
  // from the deployed app (console: "img-src ... blocked ... auth.mosni.dev/avatar/hannah").
  it("CSP allows auth.mosni.dev as an img-src, so the uploader avatar is not blocked (D-169)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    const imgSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

    expect(imgSrc).toContain("https://auth.mosni.dev");
  });

  it("GET /api/config returns the server-authoritative upload chunk size (P10) and expiry window (E6 A4)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: { host: "files.mosni.dev" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ uploadChunkSize: UPLOAD_CHUNK_SIZE, uploadExpiryMs: UPLOAD_EXPIRY_MS });
  });
});
