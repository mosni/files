import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { CSP_DIRECTIVES } from "../../src/lib/csp.ts";
import { registerEmbedRoutes } from "../../src/routes/embed.ts";
import { applyMigrations, closeDb, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { initEmbedShell } from "../../src/storage/embedShell.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const FILES_HOST = "files.mosni.dev";

// A minimal stand-in for web/embed.html - just enough for injectHead's </head> splice to have somewhere
// to land (H1: genuinely minimal, no <mosni-header>, no auth SDK, unlike the SPA shell other suites fake).
const FAKE_EMBED_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/embed-test.js"></script>
  </body>
</html>`;

describe("routes/embed.ts + controllers/embed.ts (E5 Wave H, D-140)", () => {
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "embed-test-"));
    initFilesStorage(root);

    const shellRoot = await mkdtemp(path.join(os.tmpdir(), "embed-test-shell-"));
    await writeFile(path.join(shellRoot, "embed.html"), FAKE_EMBED_SHELL);
    initEmbedShell(shellRoot);

    app = Fastify({ logger: false });
    // Registered ONCE, globally, exactly as server.ts does - and from the same shared CSP_DIRECTIVES, so
    // this can never become a drifting copy of the real policy. That single global registration IS the
    // trap H2 is guarding against (it is what produced D-77), so a test that omits helmet entirely cannot
    // see a leak of the embed route's widened frame-ancestors onto an ordinary page.
    await app.register(helmet, {
      referrerPolicy: { policy: "no-referrer" },
      contentSecurityPolicy: { directives: { ...CSP_DIRECTIVES, upgradeInsecureRequests: null } },
    });
    // A stand-in for "any ordinary page" - the second half of the never-delete invariant below, which
    // requires BOTH responses to be asserted in the same test against the same app instance.
    app.get("/__ordinary", async () => ({ ok: true }));
    await registerEmbedRoutes(app, makeTestConfig({ storageRoot: root }));
    await app.ready();
  }, 30_000);

  function frameAncestorsOf(csp: string): string {
    return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors")) ?? "";
  }

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  async function seed(opts: {
    name: string;
    protection: Protection;
    collectionProtection?: Protection;
    width?: number | null;
    height?: number | null;
  }): Promise<{ collectionName: string }> {
    const collection = await createCollection({
      parentId: "",
      name: `c-${randomUUID()}`,
      ownerSub: "user:owner",
      protection: opts.collectionProtection,
    });
    const claimed = await claimFileRow({
      collectionId: collection.id,
      name: opts.name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${opts.name}`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: opts.protection,
      uploaderName: null,
    });
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await commitFileRow(claimed.id, {
      bytes: 7,
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      durationSeconds: 10,
      textPreview: null,
      thumbName: null,
      isText: false,
    });
    return { collectionName: collection.name };
  }

  const get = (url: string) => app.inject({ method: "GET", url, headers: { host: FILES_HOST } });

  it("a public video renders: 200, minimal shell, embedded context, widened frame-ancestors", async () => {
    const { collectionName } = await seed({ name: "clip.mp4", protection: "public" });
    const res = await get(`/embed/f/${collectionName}/clip.mp4`);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("clip.mp4");
    expect(res.body).toContain('id="preview-context"');
    // H1: this route splices into the EMBED shell, never the SPA's. ⚠ Review session 055 rewrote this,
    // twice over. It used to read `expect(res.body).not.toContain("mosni-header")`, which was doubly
    // hollow: E7.5 Wave E deleted that tag from index.html as well, so it no longer told the two shells
    // apart at all - and, more fundamentally, this suite installs its own FAKE_EMBED_SHELL above, so every
    // "the response carries no app chrome" assertion here only ever asserts about a string this file wrote
    // itself. That is the stub-of-the-thing-that-breaks shape (HANDOFF.md): the fixture has removed the
    // only risk the assertion exists to catch. The load-bearing check is the POSITIVE one - a marker only
    // the embed shell carries, which does fail if controllers/embed.ts ever splices getSpaShell() instead.
    // The real `web/embed.html` is guarded where it actually lives, as a file, by
    // web/test/unit/htmlEntries.test.ts.
    expect(res.body).toContain("/assets/embed-test.js");

    const csp = res.headers["content-security-policy"] as string;
    const frameAncestors = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors"));
    expect(frameAncestors).toContain("https://twitter.com");
    expect(frameAncestors).toContain("https://x.com");
    // The default, restrictive frame-ancestors must NOT survive on this response.
    expect(frameAncestors).not.toContain("'self'");
  });

  // MANDATORY, NEVER-DELETE (verification-concept.md): "the embeddable route's widened frame-ancestors
  // never leaks onto an ordinary page (D-140) - helmet is registered once, globally (the exact trap D-77
  // already found once for dl.'s responses), so this must be asserted on BOTH the embed route and an
  // ordinary route in the same test."
  //
  // Added by the E5/E5.1 review session (2026-08-04). Until then the two halves lived in two different
  // suites against two different app instances, and neither asserted the direction that actually matters:
  // security-headers.test.ts only checked that an ordinary page CONTAINS files.mosni.dev, which would pass
  // just as happily if twitter.com/discord.com had leaked in alongside it. Assert the absence, on the same
  // app, after the embed response has already been produced.
  it("the widened frame-ancestors never leaks onto an ordinary page (D-140/D-77, never-delete)", async () => {
    const { collectionName } = await seed({ name: "clip.mp4", protection: "public" });

    const embed = await get(`/embed/f/${collectionName}/clip.mp4`);
    const embedAncestors = frameAncestorsOf(embed.headers["content-security-policy"] as string);
    expect(embedAncestors).toContain("https://twitter.com");

    // Same app, same single global helmet registration, requested AFTER the widened response above.
    const ordinary = await get("/__ordinary");
    const ordinaryAncestors = frameAncestorsOf(ordinary.headers["content-security-policy"] as string);
    expect(ordinaryAncestors).toBe("frame-ancestors 'self' https://files.mosni.dev");
    for (const origin of [
      "https://twitter.com",
      "https://x.com",
      "https://discord.com",
      "https://canary.discord.com",
      "https://ptb.discord.com",
    ]) {
      expect(ordinaryAncestors).not.toContain(origin);
    }
  });

  // D-160 (E5.1 Wave B, finding 3): same stamp as the ordinary preview document - the embed route reuses
  // renderEmbeddedContext, so it must reuse the D-160 fix too, not just the mechanism.
  it("stamps embeddedFor with the embed route's own request path, not the file's own name/path", async () => {
    const { collectionName } = await seed({ name: "clip.mp4", protection: "public" });
    const res = await get(`/embed/f/${collectionName}/clip.mp4`);

    const match = /<script type="application\/json" id="preview-context">(.*?)<\/script>/.exec(res.body);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]).embeddedFor).toBe(`/embed/f/${collectionName}/clip.mp4`);
  });

  it("an unlisted video also renders (readable path resolves)", async () => {
    const { collectionName } = await seed({ name: "clip.mp4", protection: "unlisted" });
    const res = await get(`/embed/f/${collectionName}/clip.mp4`);
    expect(res.statusCode).toBe(200);
  });

  it("a secret video 404s - no /embed/t/:token exists at all (H2, never-delete)", async () => {
    const { collectionName } = await seed({ name: "clip.mp4", protection: "secret" });
    const res = await get(`/embed/f/${collectionName}/clip.mp4`);
    expect(res.statusCode).toBe(404);
  });

  it("a private video 404s even though its readable path would otherwise resolve (H2, never-delete)", async () => {
    const { collectionName } = await seed({ name: "clip.mp4", protection: "private" });
    const res = await get(`/embed/f/${collectionName}/clip.mp4`);
    expect(res.statusCode).toBe(404);
  });

  it("a collection-gated video 404s at its readable path, mirroring the ordinary preview gate", async () => {
    const { collectionName } = await seed({
      name: "clip.mp4",
      protection: "public",
      collectionProtection: "private",
    });
    const res = await get(`/embed/f/${collectionName}/clip.mp4`);
    expect(res.statusCode).toBe(404);
  });

  it("a non-video file 404s - this route is the Wave F video player only", async () => {
    const { collectionName } = await seed({ name: "photo.jpg", protection: "public" });
    const res = await get(`/embed/f/${collectionName}/photo.jpg`);
    expect(res.statusCode).toBe(404);
  });

  it("an unknown path 404s with the styled NotFound view", async () => {
    const res = await get(`/embed/f/never-${randomUUID()}/x.mp4`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Not found");
  });
});
