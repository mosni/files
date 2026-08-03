import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { buildServer } from "../../src/server.ts";
import { applyMigrations, closeDb, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";

// The full server wires @fastify/static (unconstrained `/*`) alongside delivery's host-constrained `/*` on
// the dl host. This suite proves the precedence the whole host split relies on: a dl. request reaches
// DELIVERY (not static), which is what keeps app content off the containment origin (D-33) and is why
// static can stay unconstrained (so the SPA still serves at the container's own host for the healthcheck).
describe("server routing - static vs delivery precedence across hosts", () => {
  let root: string;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    initDb({
      host: process.env.DB_HOST ?? "mariadb",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "files",
      password: process.env.DB_PASS ?? "filespass",
      database: process.env.DB_NAME ?? "files",
    });
    await applyMigrations();
    root = await mkdtemp(path.join(os.tmpdir(), "routing-test-"));
    initFilesStorage(root);
    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
    app = await buildServer(redis, makeTestConfig({ storageRoot: root }));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  async function seedCommittedFile(name: string): Promise<{ collectionName: string }> {
    const collection = await createCollection({ parentId: "", name: `c-${randomUUID()}`, ownerSub: "user:owner" });
    const claimed = await claimFileRow({
      collectionId: collection.id,
      name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${name}`,
      ownerSub: "user:owner",
      uploaderSub: "user:owner",
      protection: "public",
      uploaderName: null,
    });
    const abs = path.join(root, diskRelPath(claimed));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "bytes");
    await commitFileRow(claimed.id, { bytes: 5, width: null, height: null, durationSeconds: null, textPreview: null, thumbName: null });
    return { collectionName: collection.name };
  }

  it("a dl. request for a real file reaches delivery (X-Accel-Redirect), NOT static (D-33 precedence)", async () => {
    const { collectionName } = await seedCommittedFile("deep.txt");

    const res = await app.inject({
      method: "GET",
      url: `/${collectionName}/deep.txt`,
      headers: { host: "dl.mosni.dev" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["x-accel-redirect"]).toMatch(/^\/internal-storage\/2026\/07\//);
  });

  it("a files. preview request reaches the preview route (/f/*), not static or delivery", async () => {
    const { collectionName } = await seedCommittedFile("pic.png");

    const res = await app.inject({
      method: "GET",
      url: `/f/${collectionName}/pic.png`,
      headers: { host: "files.mosni.dev" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('property="og:image"');
  });

  // The origin split (D-4/D-33) only buys containment if dl. carries NO app surface beyond delivery.
  // /api/upload is a static route, and find-my-way ranks a static path above delivery's host-constrained
  // wildcard - so leaving it unconstrained put an authenticated write API on the containment origin,
  // reachable through nginx's `location /` proxy in production too.
  it("the upload API is unreachable on the dl host, and answers on the files host (D-33)", async () => {
    const tusHeaders = { "tus-resumable": "1.0.0", "upload-length": "5" };

    const onDl = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { host: "dl.mosni.dev", ...tusHeaders },
    });
    expect(onDl.statusCode).toBe(404);

    // 401 rather than 404: the route exists here and rejected the request for want of a bearer token,
    // which is what proves the 404 above is the host constraint and not a broken registration.
    const onFiles = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { host: "files.mosni.dev", ...tusHeaders },
    });
    expect(onFiles.statusCode).toBe(401);
  });

  it("/api/config is unreachable on the dl host too", async () => {
    const onDl = await app.inject({ method: "GET", url: "/api/config", headers: { host: "dl.mosni.dev" } });
    expect(onDl.statusCode).toBe(404);
  });

  it("the manage API is unreachable on the dl host too (D-33 - the mutation API is files.-only)", async () => {
    const onDl = await app.inject({ method: "GET", url: "/api/collections", headers: { host: "dl.mosni.dev" } });
    expect(onDl.statusCode).toBe(404);
  });

  it("/health answers on any host (unconstrained, for the deploy healthcheck)", async () => {
    for (const host of ["files.mosni.dev", "dl.mosni.dev", "127.0.0.1"]) {
      const res = await app.inject({ method: "GET", url: "/health", headers: { host } });
      expect(res.statusCode).toBe(200);
    }
  });
});
