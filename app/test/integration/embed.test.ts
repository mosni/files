import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
    await registerEmbedRoutes(app, makeTestConfig({ storageRoot: root }));
    await app.ready();
  }, 30_000);

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
    // No app chrome in the shell this route splices into (H1).
    expect(res.body).not.toContain("mosni-header");
    expect(res.body).not.toContain("auth.mosni.dev/sdk.js");

    const csp = res.headers["content-security-policy"] as string;
    const frameAncestors = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors"));
    expect(frameAncestors).toContain("https://twitter.com");
    expect(frameAncestors).toContain("https://x.com");
    // The default, restrictive frame-ancestors must NOT survive on this response.
    expect(frameAncestors).not.toContain("'self'");
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
