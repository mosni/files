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

  // E7.5 Wave E / AC9, added by review session 055. The whole point of swapping `<mosni-header>` for
  // `<Header>` here is that the 404 arrives with REAL chrome markup instead of a bare custom-element tag
  // that only becomes markup once mosnicat-core.js runs - and this page ships no app JS at all, so on the
  // old code it never became markup for a user who only ever sees this one document. Session 054 proved
  // that by hand, with a curl inside the container; nothing asserted it, so a revert to the bare tag would
  // have been silent at every tier. Asserted on the raw response BODY (D-200's rule: the shape the real
  // caller actually receives), never a post-JS DOM - the post-JS DOM is exactly what used to be fine.
  it("server-renders REAL chrome markup on the 404, not a bare tag that needs client JS (AC9)", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-path" });

    expect(res.body).toContain('<header class="header"');
    expect(res.body).toContain('class="brand"');
    // ...and no unupgraded custom element left behind anywhere in the document.
    expect(res.body).not.toContain("<mosni-header");
    expect(res.body).not.toContain("<mosni-layout");
  });

  // AC11, the epic's own "single most likely way to get this badly wrong": @mosni/react ships ZERO CSS
  // (D-R2), so this <script> is the only thing that styles the page. Nothing else can catch its removal -
  // the D-79 visual check never opens a 404, and every other tier here asserts text, not styling. A future
  // session tidying up "we don't use mosni-* elements any more" is the realistic way this goes.
  it("still loads the mosnicat.js bootstrap - @mosni/react ships no CSS of its own (AC11)", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-path" });

    expect(res.body).toContain('<script src="https://ui.mosni.dev/mosnicat.js"></script>');
    // D-54 still holds: no auth SDK, no app JS on an error page.
    expect(res.body).not.toContain("auth.mosni.dev/sdk.js");
  });

  it("carries the security headers on the rendered view too, not only on JSON routes", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-path" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });
});
