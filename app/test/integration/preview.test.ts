import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPreviewRoutes } from "../../src/routes/preview.ts";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { deleteFileRow, initFilesStorage } from "../../src/storage/files.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";

const FILES_HOST = "files.mosni.dev";
const DL_HOST = "dl.mosni.dev";

describe("routes/preview.ts + views/Preview.tsx (E5a, session 007 URL model)", () => {
  let root: string;
  let app: FastifyInstance;
  const createdPaths: string[] = [];

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

    app = Fastify({ logger: false });
    await registerPreviewRoutes(app, makeTestConfig({ storageRoot: root }));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    while (createdPaths.length > 0) await deleteFileRow(createdPaths.pop()!);
  });

  async function seed(opts: { relPath: string; protection: Protection }): Promise<{ linkToken: string }> {
    createdPaths.push(opts.relPath);
    const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
    const abs = path.join(root, ...opts.relPath.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await getPool().query(
      "INSERT INTO files (path, bytes, protection, link_token, owner_sub, uploader_sub) VALUES (?, 7, ?, ?, NULL, NULL)",
      [opts.relPath, opts.protection, linkToken],
    );
    return { linkToken };
  }

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { host: FILES_HOST, ...headers } });

  it("renders OG tags with og:image at the direct dl. URL for an image", async () => {
    const relPath = `h-${randomUUID()}/photo.jpg`;
    await seed({ relPath, protection: "public" });
    const res = await get(`/f/${relPath}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('property="og:title" content="photo.jpg"');
    expect(res.body).toContain(`property="og:image" content="https://${DL_HOST}/${relPath}"`);
  });

  it("renders og:video + twitter:card=player for a video, not og:image", async () => {
    const relPath = `v-${randomUUID()}/clip.mp4`;
    await seed({ relPath, protection: "public" });
    const res = await get(`/f/${relPath}`);
    expect(res.body).toContain('property="og:video"');
    expect(res.body).toContain('name="twitter:card" content="player"');
    expect(res.body).not.toContain("og:image");
  });

  it("renders a download card for a non-allowlisted extension", async () => {
    const relPath = `z-${randomUUID()}/a.zip`;
    await seed({ relPath, protection: "public" });
    const res = await get(`/f/${relPath}`);
    expect(res.body).toContain("does not preview inline");
  });

  it("presents the preview link (primary) and the direct link (secondary) as read-only inputs (P9/D-1)", async () => {
    const relPath = `n-${randomUUID()}/notes.txt`;
    await seed({ relPath, protection: "unlisted" });
    const res = await get(`/f/${relPath}`);
    expect(res.body).toContain(`value="https://${FILES_HOST}/f/${relPath}"`);
    expect(res.body).toContain(`value="https://${DL_HOST}/${relPath}"`);
    // React SSR emits the boolean prop as readOnly=""; HTML attribute names are case-insensitive.
    expect(res.body.toLowerCase()).toContain("readonly");
  });

  it("loads the chrome but NOT the auth SDK (island probe dropped, session 007)", async () => {
    const relPath = `c-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "unlisted" });
    const res = await get(`/f/${relPath}`);
    expect(res.body).toContain("ui.mosni.dev/mosnicat.js");
    expect(res.body).not.toContain("auth.mosni.dev/sdk.js");
  });

  it("sets no cookie and renders identically with or without an Authorization header", async () => {
    const relPath = `s-${randomUUID()}/same.txt`;
    await seed({ relPath, protection: "public" });
    const anon = await get(`/f/${relPath}`);
    const withAuth = await get(`/f/${relPath}`, { authorization: "Bearer x" });
    expect(withAuth.body).toBe(anon.body);
    expect(anon.headers["set-cookie"]).toBeUndefined();
  });

  it("404s a secret file at its readable /f/ path but renders it at /t/:token", async () => {
    const relPath = `k-${randomUUID()}/hidden.txt`;
    const { linkToken } = await seed({ relPath, protection: "secret" });
    expect((await get(`/f/${relPath}`)).statusCode).toBe(404);
    const byToken = await get(`/t/${linkToken}`);
    expect(byToken.statusCode).toBe(200);
    expect(byToken.body).toContain("hidden.txt");
  });
});
