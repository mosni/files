import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// auth.mosni.dev is not reachable from this sandbox - mocking verify() is the only way to exercise the
// `private` authorized paths at all (same reasoning as upload.test.ts).
vi.mock("../../src/auth/verify.ts", () => ({ verify: vi.fn() }));

import { verify } from "../../src/auth/verify.ts";
import { registerPreviewRoutes } from "../../src/routes/preview.ts";
import { applySchema, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { deleteFileRow, initFilesStorage } from "../../src/storage/files.ts";
import { initSpaShell } from "../../src/storage/spaShell.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";
import type { PreviewContext } from "../../src/lib/previewContext.ts";

const verifyMock = vi.mocked(verify);
const FILES_HOST = "files.mosni.dev";

// A faithful stand-in for the real web/index.html (D-70/D-72): the document is now this shell with the
// server-rendered <head> spliced in, not a hand-written SSR page.
const FAKE_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Hannah's File Drop</title>
    <script src="https://auth.mosni.dev/sdk.js"></script>
    <script src="https://ui.mosni.dev/mosnicat.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/index-test.js"></script>
  </body>
</html>`;

describe("routes/preview.ts + controllers/preview.ts (D-70 preview re-architecture)", () => {
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

    const spaRoot = await mkdtemp(path.join(os.tmpdir(), "preview-test-spa-"));
    await writeFile(path.join(spaRoot, "index.html"), FAKE_SHELL);
    initSpaShell(spaRoot);

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
    vi.mocked(verify).mockReset();
    while (createdPaths.length > 0) await deleteFileRow(createdPaths.pop()!);
  });

  async function seed(opts: {
    relPath: string;
    protection: Protection;
    ownerSub?: string | null;
    width?: number | null;
    height?: number | null;
  }): Promise<{ linkToken: string }> {
    createdPaths.push(opts.relPath);
    const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
    const abs = path.join(root, ...opts.relPath.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await getPool().query(
      "INSERT INTO files (path, bytes, protection, link_token, owner_sub, width, height) VALUES (?, 7, ?, ?, ?, ?, ?)",
      [
        opts.relPath,
        opts.protection,
        linkToken,
        opts.ownerSub ?? null,
        opts.width ?? null,
        opts.height ?? null,
      ],
    );
    return { linkToken };
  }

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { host: FILES_HOST, ...headers } });

  function embeddedContextOf(body: string): PreviewContext {
    const match = /<script type="application\/json" id="preview-context">(.*?)<\/script>/.exec(body);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]) as PreviewContext;
  }

  // --- Document contract (D-72's table, implemented literally) -----------------------------------

  it("public/unlisted: 200, full head, embedded context", async () => {
    const relPath = `pub-${randomUUID()}/photo.jpg`;
    await seed({ relPath, protection: "public", width: 800, height: 600 });
    const res = await get(`/f/${relPath}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('property="og:title" content="photo.jpg"');
    expect(res.body).toContain('property="og:image"');
    const ctx = embeddedContextOf(res.body);
    expect(ctx.name).toBe("photo.jpg");
    expect(ctx.isOwner).toBe(false);
  });

  it("private: 200, minimal head only, no OG, no embedded context, no filename anywhere", async () => {
    const relPath = `priv-${randomUUID()}/secret-plans.txt`;
    await seed({ relPath, protection: "private", ownerSub: "user:owner" });
    const res = await get(`/f/${relPath}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("og:");
    expect(res.body).not.toContain("secret-plans.txt");
    expect(res.body).not.toContain("canonical");
    expect(res.body).not.toContain("preview-context");
    expect(res.body).toContain("noindex, nofollow");
  });

  it("secret: 404 at its readable /f/ path, 200 with full head at /t/:token (D-59, never-delete)", async () => {
    const relPath = `sec-${randomUUID()}/hidden.txt`;
    const { linkToken } = await seed({ relPath, protection: "secret" });

    const byPath = await get(`/f/${relPath}`);
    expect(byPath.statusCode).toBe(404);
    expect(byPath.body).toContain("Not found");

    const byToken = await get(`/t/${linkToken}`);
    expect(byToken.statusCode).toBe(200);
    expect(byToken.body).toContain("hidden.txt");
  });

  it("no row, and an unknown token: both 404 with the styled NotFound view", async () => {
    const missing = await get(`/f/never-${randomUUID()}/x.txt`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("Not found");

    const unknownToken = await get("/t/ZZZZZ");
    expect(unknownToken.statusCode).toBe(404);
    expect(unknownToken.body).toContain("Not found");
  });

  it("the document body is the SPA shell - its own script tags and #root are present, not hand-rendered chrome", async () => {
    const relPath = `shell-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "unlisted" });
    const res = await get(`/f/${relPath}`);

    expect(res.body).toContain("https://auth.mosni.dev/sdk.js");
    expect(res.body).toContain("https://ui.mosni.dev/mosnicat.js");
    expect(res.body).toContain('<div id="root">');
    expect(res.body).toContain("/assets/index-test.js");
  });

  it("the embedded context's previewUrl/directUrl match buildFileUrls", async () => {
    const relPath = `urls-${randomUUID()}/n.txt`;
    await seed({ relPath, protection: "unlisted" });
    const res = await get(`/f/${relPath}`);
    const ctx = embeddedContextOf(res.body);

    expect(ctx.previewUrl).toBe(`https://${FILES_HOST}/f/${relPath}`);
    expect(ctx.directUrl).toBe(`https://dl.mosni.dev/${relPath}`);
  });

  it("sets no cookie and renders identically with or without an Authorization header (D-75, never-delete)", async () => {
    const relPath = `s-${randomUUID()}/same.txt`;
    await seed({ relPath, protection: "public" });
    const anon = await get(`/f/${relPath}`);
    const withAuth = await get(`/f/${relPath}`, { authorization: "Bearer x" });
    expect(withAuth.body).toBe(anon.body);
    expect(anon.headers["set-cookie"]).toBeUndefined();
  });

  it("a filename containing a raw HTML/script payload executes nothing and appears with no literal unescaped tag", async () => {
    // No `/` in this payload - safeSegment() rejects any `/` in a real filename (a genuine `</script>`
    // breakout string is exercised end-to-end at the pure-function level instead, in previewHead.test.ts,
    // which is not subject to path-segment splitting). This still exercises the same `<`-escaping
    // end-to-end through the full HTTP stack, which is this test's added value.
    const evilName = "a<img src=x onerror=alert(1)>b.png";
    const relPath = `xss-${randomUUID()}/${evilName}`;
    await seed({ relPath, protection: "public" });
    // A real client always percent-encodes the URL.
    const encodedPath = relPath.split("/").map(encodeURIComponent).join("/");
    const res = await get(`/f/${encodedPath}`);

    expect(res.body).not.toContain("<img src=x onerror=alert(1)>b.png");
    expect(embeddedContextOf(res.body).name).toBe(evilName);
  });

  // --- API contract --------------------------------------------------------------------------------

  it("GET /api/preview/f/<public path> returns the context as JSON; isOwner false with no Bearer", async () => {
    const relPath = `api-pub-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "unlisted", ownerSub: "user:owner" });
    const res = await get(`/api/preview/f/${relPath}`);

    expect(res.statusCode).toBe(200);
    const ctx = res.json() as PreviewContext;
    expect(ctx.path).toBe(relPath);
    expect(ctx.isOwner).toBe(false);
  });

  it("GET /api/preview/f/<public path> with an owner Bearer returns isOwner: true", async () => {
    const relPath = `api-owner-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "unlisted", ownerSub: "user:owner" });
    verifyMock.mockResolvedValue({ sub: "user:owner" } as never);

    const res = await get(`/api/preview/f/${relPath}`, { authorization: "Bearer t" });
    expect((res.json() as PreviewContext).isOwner).toBe(true);
  });

  it("GET /api/preview/f/<public path> with a non-owner Bearer returns isOwner: false", async () => {
    const relPath = `api-other-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "unlisted", ownerSub: "user:owner" });
    verifyMock.mockResolvedValue({ sub: "user:someone-else" } as never);

    const res = await get(`/api/preview/f/${relPath}`, { authorization: "Bearer t" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as PreviewContext).isOwner).toBe(false);
  });

  it("GET /api/preview/f/<private path>: 404 with no Bearer, 404 with a non-owner's Bearer", async () => {
    const relPath = `api-priv-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "private", ownerSub: "user:owner" });

    expect((await get(`/api/preview/f/${relPath}`)).statusCode).toBe(404);

    verifyMock.mockResolvedValue({ sub: "user:someone-else" } as never);
    expect((await get(`/api/preview/f/${relPath}`, { authorization: "Bearer t" })).statusCode).toBe(404);
  });

  it("GET /api/preview/f/<private path>: 200 with the owner's, a superuser's, or an ACL-granted Bearer", async () => {
    const relPath = `api-priv-ok-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "private", ownerSub: "user:owner" });

    verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
    const asOwner = await get(`/api/preview/f/${relPath}`, { authorization: "Bearer t" });
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as PreviewContext).isOwner).toBe(true);

    verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true } as never);
    expect((await get(`/api/preview/f/${relPath}`, { authorization: "Bearer t" })).statusCode).toBe(200);

    const grantedSub = `user:${randomUUID()}`;
    await getPool().query("INSERT INTO file_acl (path, sub) VALUES (?, ?)", [relPath, grantedSub]);
    verifyMock.mockResolvedValue({ sub: grantedSub } as never);
    expect((await get(`/api/preview/f/${relPath}`, { authorization: "Bearer t" })).statusCode).toBe(200);
  });

  it("GET /api/preview/f/<secret's readable path> is 404 (same gate as the document)", async () => {
    const relPath = `api-sec-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "secret" });
    expect((await get(`/api/preview/f/${relPath}`)).statusCode).toBe(404);
  });

  it("GET /api/preview/t/:token works for a secret file and never sets a cookie", async () => {
    const relPath = `api-sec-tok-${randomUUID()}/x.txt`;
    const { linkToken } = await seed({ relPath, protection: "secret" });
    const res = await get(`/api/preview/t/${linkToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  // --- oEmbed (D-74) --------------------------------------------------------------------------------

  it("GET /api/oembed returns oEmbed 1.0 JSON for a public image, type photo with dimensions", async () => {
    const relPath = `oe-${randomUUID()}/photo.png`;
    await seed({ relPath, protection: "public", width: 640, height: 480 });
    const previewUrl = `https://${FILES_HOST}/f/${relPath}`;

    const res = await get(`/api/oembed?url=${encodeURIComponent(previewUrl)}&format=json`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      version: "1.0",
      type: "photo",
      provider_name: "Hannah's File Drop",
      width: 640,
      height: 480,
    });
  });

  it("GET /api/oembed falls back to type link for a non-image kind", async () => {
    const relPath = `oe-link-${randomUUID()}/notes.txt`;
    await seed({ relPath, protection: "public" });
    const previewUrl = `https://${FILES_HOST}/f/${relPath}`;

    const res = await get(`/api/oembed?url=${encodeURIComponent(previewUrl)}`);
    expect((res.json() as { type: string }).type).toBe("link");
  });

  it("GET /api/oembed 404s for a private file, an unknown file, and a url outside this origin", async () => {
    const relPath = `oe-priv-${randomUUID()}/x.txt`;
    await seed({ relPath, protection: "private", ownerSub: "user:owner" });
    const privateUrl = `https://${FILES_HOST}/f/${relPath}`;
    expect((await get(`/api/oembed?url=${encodeURIComponent(privateUrl)}`)).statusCode).toBe(404);

    const unknownUrl = `https://${FILES_HOST}/f/never-${randomUUID()}/x.txt`;
    expect((await get(`/api/oembed?url=${encodeURIComponent(unknownUrl)}`)).statusCode).toBe(404);

    const foreignUrl = "https://evil.example/f/whatever";
    expect((await get(`/api/oembed?url=${encodeURIComponent(foreignUrl)}`)).statusCode).toBe(404);

    expect((await get("/api/oembed")).statusCode).toBe(404);
  });
});
