import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPreviewRoutes } from "../../src/routes/preview.ts";
import type { Config } from "../../src/config.ts";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { initFilesStorage } from "../../src/storage/files.ts";

const FILES_HOST = "files.mosni.dev";
const DL_HOST = "dl.mosni.dev";

// D-9/D-54: the server-rendered preview page. Session-awareness is client-side only (D-63), so every
// assertion here checks the SSR output is identical regardless of who's asking - there is nothing to
// branch on server-side.
describe("routes/preview.ts + views/Preview.tsx (E5a)", () => {
  let root: string;
  let app: FastifyInstance;
  let config: Config;
  const createdCollectionNames: string[] = [];

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applySchema();
    root = await mkdtemp(path.join(os.tmpdir(), "preview-test-"));
    initFilesStorage(root);

    config = {
      db: { host: "mariadb", port: 3306, user: "files", pass: "filespass", name: "files" },
      redisUrl: "redis://redis:6379",
      botApi: "http://bot-core:8080",
      authIssuer: "https://auth.mosni.dev",
      appOrigin: `https://${FILES_HOST}`,
      dlOrigin: `https://${DL_HOST}`,
      storageRoot: root,
      tusTempDir: path.join(root, ".tus"),
      port: 0,
    };

    app = Fastify({ logger: false });
    await registerPreviewRoutes(app, config);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    while (createdCollectionNames.length > 0) {
      const name = createdCollectionNames.pop()!;
      await getPool().query(
        "DELETE FROM files WHERE collection_id IN (SELECT id FROM collections WHERE name = ?)",
        [name],
      );
      await getPool().query("DELETE FROM collections WHERE name = ?", [name]);
    }
  });

  async function seedFile(opts: {
    protection: "public" | "unlisted" | "secret" | "private";
    name: string;
  }): Promise<{ collection: string; linkToken: string }> {
    const collection = `coll-${randomUUID()}`;
    createdCollectionNames.push(collection);
    const collectionId = randomUUID();
    await getPool().query(
      "INSERT INTO collections (id, owner_sub, name, protection, is_default) VALUES (?, NULL, ?, ?, FALSE)",
      [collectionId, collection, opts.protection],
    );
    await mkdir(path.join(root, collection), { recursive: true });
    await writeFile(path.join(root, collection, opts.name), "content");
    const linkToken = randomUUID().replace(/-/g, "").slice(0, 22);
    await getPool().query(
      "INSERT INTO files (collection_id, display_name, bytes, protection, link_token, uploader_sub) VALUES (?, ?, 7, ?, ?, NULL)",
      [collectionId, opts.name, opts.protection, linkToken],
    );
    return { collection, linkToken };
  }

  it("renders OG tags with og:image pointing at the direct dl. URL for an image", async () => {
    const { collection } = await seedFile({ protection: "public", name: "photo.jpg" });
    const res = await app.inject({
      method: "GET",
      url: `/${collection}/photo.jpg`,
      headers: { host: FILES_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('property="og:title" content="photo.jpg"');
    expect(res.body).toContain(`property="og:image" content="https://${DL_HOST}/${collection}/photo.jpg"`);
  });

  it("renders og:video + twitter:card=player for a video, not og:image", async () => {
    const { collection } = await seedFile({ protection: "public", name: "clip.mp4" });
    const res = await app.inject({
      method: "GET",
      url: `/${collection}/clip.mp4`,
      headers: { host: FILES_HOST },
    });
    expect(res.body).toContain('property="og:video"');
    expect(res.body).toContain('name="twitter:card" content="player"');
    expect(res.body).not.toContain("og:image");
  });

  it("renders a download card (not inline media) for a non-allowlisted extension", async () => {
    const { collection } = await seedFile({ protection: "public", name: "archive.zip" });
    const res = await app.inject({
      method: "GET",
      url: `/${collection}/archive.zip`,
      headers: { host: FILES_HOST },
    });
    expect(res.body).toContain("does not preview inline");
    expect(res.body).not.toContain("<img");
    expect(res.body).not.toContain("<video");
  });

  it("presents the preview link as the primary copy target, and the direct link as secondary (D-1)", async () => {
    const { collection, linkToken } = await seedFile({ protection: "unlisted", name: "notes.txt" });
    const res = await app.inject({
      method: "GET",
      url: `/${collection}/notes.txt`,
      headers: { host: FILES_HOST },
    });
    expect(res.body).toContain(`data-copy-link="https://${FILES_HOST}/${collection}/notes.txt"`);
    expect(res.body).toContain(`href="https://${DL_HOST}/${collection}/notes.txt"`);
    // The embedded context-probe script targets this file's own token, regardless of which URL shape
    // rendered the page.
    expect(res.body).toContain(`/api/f/${linkToken}/context`);
  });

  it("loads the auth SDK before the chrome (load-order rule, belt-and-braces for D-63's window.mosni fix)", async () => {
    const { collection } = await seedFile({ protection: "unlisted", name: "x.txt" });
    const res = await app.inject({
      method: "GET",
      url: `/${collection}/x.txt`,
      headers: { host: FILES_HOST },
    });
    const sdkIndex = res.body.indexOf("auth.mosni.dev/sdk.js");
    const chromeIndex = res.body.indexOf("ui.mosni.dev/mosnicat.js");
    expect(sdkIndex).toBeGreaterThan(-1);
    expect(chromeIndex).toBeGreaterThan(sdkIndex);
  });

  it("sets no cookie and is served with the same headers regardless of an Authorization header (D-63/D-33)", async () => {
    const { collection } = await seedFile({ protection: "public", name: "same.txt" });
    const anon = await app.inject({
      method: "GET",
      url: `/${collection}/same.txt`,
      headers: { host: FILES_HOST },
    });
    const withAuth = await app.inject({
      method: "GET",
      url: `/${collection}/same.txt`,
      headers: { host: FILES_HOST, authorization: "Bearer whatever" },
    });
    expect(withAuth.body).toBe(anon.body);
    expect(anon.headers["set-cookie"]).toBeUndefined();
    expect(withAuth.headers["set-cookie"]).toBeUndefined();
  });

  it("404s a secret file requested at its readable preview path", async () => {
    const { collection } = await seedFile({ protection: "secret", name: "hidden.txt" });
    const res = await app.inject({
      method: "GET",
      url: `/${collection}/hidden.txt`,
      headers: { host: FILES_HOST },
    });
    expect(res.statusCode).toBe(404);
  });

  it("still renders a secret file at its /f/:token preview path", async () => {
    const { linkToken } = await seedFile({ protection: "secret", name: "hidden.txt" });
    const res = await app.inject({ method: "GET", url: `/f/${linkToken}`, headers: { host: FILES_HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hidden.txt");
  });
});
