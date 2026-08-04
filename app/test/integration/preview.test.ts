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
import { applyMigrations, closeDb, getPool, initDb } from "../../src/storage/db.ts";
import { claimFileRow, commitFileRow, diskRelPath, initFilesStorage } from "../../src/storage/files.ts";
import { createCollection } from "../../src/storage/collections.ts";
import { initSpaShell } from "../../src/storage/spaShell.ts";
import { makeTestConfig } from "../helpers/testConfig.ts";
import type { Protection } from "../../src/lib/protection.ts";
import type { PreviewContext } from "../../src/lib/previewContext.ts";
import type { CollectionLocation } from "../../src/lib/browseContext.ts";

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

describe("routes/preview.ts + controllers/preview.ts (D-81/D-84: resolved through the database by name)", () => {
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
  });

  // Creates a fresh root-level collection plus a fully-committed file inside it, with real bytes on disk.
  async function seed(opts: {
    name: string;
    protection: Protection;
    collectionProtection?: Protection;
    ownerSub?: string | null;
    width?: number | null;
    height?: number | null;
  }): Promise<{ collectionId: string; collectionName: string; linkToken: string; fileId: string }> {
    const collection = await createCollection({
      parentId: "",
      name: `c-${randomUUID()}`,
      ownerSub: opts.ownerSub ?? "user:owner",
      protection: opts.collectionProtection,
    });
    const claimed = await claimFileRow({
      collectionId: collection.id,
      name: opts.name,
      diskDir: "2026/07",
      diskName: `${randomUUID()}-${opts.name}`,
      ownerSub: opts.ownerSub ?? "user:no-owner-placeholder",
      uploaderSub: opts.ownerSub ?? "user:owner",
      protection: opts.protection,
      uploaderName: null,
    });
    const abs = path.join(root, ...diskRelPath(claimed).split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "content");
    await commitFileRow(claimed.id, {
      bytes: 7,
      width: opts.width ?? null,
      height: opts.height ?? null,
      durationSeconds: null,
      textPreview: null,
      thumbName: null,
    });
    return {
      collectionId: collection.id,
      collectionName: collection.name,
      linkToken: claimed.linkToken,
      fileId: claimed.id,
    };
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
    const { collectionName } = await seed({ name: "photo.jpg", protection: "public", width: 800, height: 600 });
    const res = await get(`/f/${collectionName}/photo.jpg`);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('property="og:title" content="photo.jpg"');
    expect(res.body).toContain('property="og:image"');
    const ctx = embeddedContextOf(res.body);
    expect(ctx.name).toBe("photo.jpg");
    expect(ctx.isOwner).toBe(false);
  });

  // D-160 (E5.1 Wave B, finding 3): the server stamps the path it actually rendered the document for, so
  // the client can tell "this is what I'm currently looking at" apart from stale content left over from an
  // earlier mount - never derived from the file's own name/path, which can differ from the request path
  // that reached it (a token route, for instance).
  it("the embedded context's embeddedFor equals the request path, for both the readable path and the token", async () => {
    const { collectionName, linkToken } = await seed({ name: "stamped.jpg", protection: "public" });

    const byPath = await get(`/f/${collectionName}/stamped.jpg`);
    expect((embeddedContextOf(byPath.body) as PreviewContext & { embeddedFor: string }).embeddedFor).toBe(
      `/f/${collectionName}/stamped.jpg`,
    );

    const byToken = await get(`/t/${linkToken}`);
    expect((embeddedContextOf(byToken.body) as PreviewContext & { embeddedFor: string }).embeddedFor).toBe(
      `/t/${linkToken}`,
    );
  });

  it("private: 200, minimal head only, no OG, no embedded context, no filename anywhere", async () => {
    const { collectionName } = await seed({
      name: "secret-plans.txt",
      protection: "private",
      ownerSub: "user:owner",
    });
    const res = await get(`/f/${collectionName}/secret-plans.txt`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("og:");
    expect(res.body).not.toContain("secret-plans.txt");
    expect(res.body).not.toContain("canonical");
    expect(res.body).not.toContain("preview-context");
    expect(res.body).toContain("noindex, nofollow");
  });

  it("secret: 404 at its readable /f/ path, 200 with full head at /t/:token (D-59, never-delete)", async () => {
    const { collectionName, linkToken } = await seed({ name: "hidden.txt", protection: "secret" });

    const byPath = await get(`/f/${collectionName}/hidden.txt`);
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

  it("the served document has exactly ONE <title>, and it is the file-specific one (B1c)", async () => {
    const { collectionName } = await seed({ name: "report.pdf", protection: "public" });
    const res = await get(`/f/${collectionName}/report.pdf`);

    // The shell carries its own generic <title> for the drop zone at `/`. Splicing a second one in
    // ahead of </head> leaves two, and every browser (and any crawler that reads <title> rather than
    // og:title) honours the FIRST - so the preview page would show the generic site name forever.
    const titles = [...res.body.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("report.pdf");
  });

  it("a private document still carries exactly one, deliberately generic, <title>", async () => {
    const { collectionName } = await seed({ name: "confidential.txt", protection: "private", ownerSub: "user:owner" });
    const res = await get(`/f/${collectionName}/confidential.txt`);

    const titles = [...res.body.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
    expect(titles).toHaveLength(1);
    expect(titles[0]).not.toContain("confidential.txt");
  });

  it("the document body is the SPA shell - its own script tags and #root are present, not hand-rendered chrome", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "unlisted" });
    const res = await get(`/f/${collectionName}/x.txt`);

    expect(res.body).toContain("https://auth.mosni.dev/sdk.js");
    expect(res.body).toContain("https://ui.mosni.dev/mosnicat.js");
    expect(res.body).toContain('<div id="root">');
    expect(res.body).toContain("/assets/index-test.js");
  });

  it("the embedded context's previewUrl/directUrl reflect the CURRENT collection/file names", async () => {
    const { collectionName } = await seed({ name: "n.txt", protection: "unlisted" });
    const res = await get(`/f/${collectionName}/n.txt`);
    const ctx = embeddedContextOf(res.body);

    expect(ctx.previewUrl).toBe(`https://${FILES_HOST}/f/${collectionName}/n.txt`);
    expect(ctx.directUrl).toBe(`https://dl.mosni.dev/${collectionName}/n.txt`);
  });

  it("the embedded context carries the file's id and collectionId (Wave F needs them for manage calls)", async () => {
    const { collectionName, fileId } = await seed({ name: "n.txt", protection: "unlisted" });
    const res = await get(`/f/${collectionName}/n.txt`);
    const ctx = embeddedContextOf(res.body);
    expect(ctx.id).toBe(fileId);
    expect(ctx.collectionId).toEqual(expect.any(String));
  });

  it("sets no cookie and renders identically with or without an Authorization header (D-75, never-delete)", async () => {
    const { collectionName } = await seed({ name: "same.txt", protection: "public" });
    const anon = await get(`/f/${collectionName}/same.txt`);
    const withAuth = await get(`/f/${collectionName}/same.txt`, { authorization: "Bearer x" });
    expect(withAuth.body).toBe(anon.body);
    expect(anon.headers["set-cookie"]).toBeUndefined();
  });

  it("a filename containing a raw HTML/script payload executes nothing and appears with no literal unescaped tag", async () => {
    const evilName = "a<img src=x onerror=alert(1)>b.png";
    const { collectionName } = await seed({ name: evilName, protection: "public" });
    // A real client always percent-encodes the URL.
    const res = await get(`/f/${collectionName}/${encodeURIComponent(evilName)}`);

    expect(res.body).not.toContain("<img src=x onerror=alert(1)>b.png");
    expect(embeddedContextOf(res.body).name).toBe(evilName);
  });

  // --- API contract --------------------------------------------------------------------------------

  it("GET /api/preview/f/<public path> returns the context as JSON; isOwner false with no Bearer", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "unlisted", ownerSub: "user:owner" });
    const res = await get(`/api/preview/f/${collectionName}/x.txt`);

    expect(res.statusCode).toBe(200);
    const ctx = res.json() as PreviewContext;
    expect(ctx.path).toBe(`${collectionName}/x.txt`);
    expect(ctx.isOwner).toBe(false);
  });

  it("GET /api/preview/f/<public path> with an owner Bearer returns isOwner: true", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "unlisted", ownerSub: "user:owner" });
    verifyMock.mockResolvedValue({ sub: "user:owner" } as never);

    const res = await get(`/api/preview/f/${collectionName}/x.txt`, { authorization: "Bearer t" });
    expect((res.json() as PreviewContext).isOwner).toBe(true);
  });

  it("GET /api/preview/f/<public path> with a non-owner Bearer returns isOwner: false", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "unlisted", ownerSub: "user:owner" });
    verifyMock.mockResolvedValue({ sub: "user:someone-else" } as never);

    const res = await get(`/api/preview/f/${collectionName}/x.txt`, { authorization: "Bearer t" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as PreviewContext).isOwner).toBe(false);
  });

  it("GET /api/preview/f/<private path>: 404 with no Bearer, 404 with a non-owner's Bearer", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "private", ownerSub: "user:owner" });

    expect((await get(`/api/preview/f/${collectionName}/x.txt`)).statusCode).toBe(404);

    verifyMock.mockResolvedValue({ sub: "user:someone-else" } as never);
    expect((await get(`/api/preview/f/${collectionName}/x.txt`, { authorization: "Bearer t" })).statusCode).toBe(404);
  });

  it("GET /api/preview/f/<private path>: 200 with the owner's, a superuser's, or an ACL-granted Bearer, each with a signed directUrl (D-84)", async () => {
    const { collectionName, fileId } = await seed({ name: "x.txt", protection: "private", ownerSub: "user:owner" });

    verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
    const asOwner = await get(`/api/preview/f/${collectionName}/x.txt`, { authorization: "Bearer t" });
    expect(asOwner.statusCode).toBe(200);
    const ownerCtx = asOwner.json() as PreviewContext;
    expect(ownerCtx.isOwner).toBe(true);
    expect(ownerCtx.directUrl).toMatch(new RegExp(`^https://dl\\.mosni\\.dev/s/${fileId}\\?exp=\\d+&sig=`));

    verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true } as never);
    expect((await get(`/api/preview/f/${collectionName}/x.txt`, { authorization: "Bearer t" })).statusCode).toBe(200);

    const grantedSub = `user:${randomUUID()}`;
    await getPool().query("INSERT INTO file_acl (file_id, sub) VALUES (?, ?)", [fileId, grantedSub]);
    verifyMock.mockResolvedValue({ sub: grantedSub } as never);
    expect((await get(`/api/preview/f/${collectionName}/x.txt`, { authorization: "Bearer t" })).statusCode).toBe(200);
  });

  it("GET /api/preview/f/<public path> never carries a signed directUrl - only private does", async () => {
    const { collectionName } = await seed({ name: "public.txt", protection: "public" });
    const res = await get(`/api/preview/f/${collectionName}/public.txt`);
    const ctx = res.json() as PreviewContext;
    expect(ctx.directUrl).not.toContain("/s/");
    expect(ctx.directUrl).not.toContain("sig=");
  });

  it("GET /api/preview/f/<secret's readable path> is 404 (same gate as the document)", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "secret" });
    expect((await get(`/api/preview/f/${collectionName}/x.txt`)).statusCode).toBe(404);
  });

  // AC7, the preview half: the readable path 404s for the owner and a superuser too, not just anonymously.
  // The `secret` gate sits in resolveDocumentByNames, ahead of every identity check, and must stay there.
  it("GET /api/preview/f/<secret's readable path> is 404 for the OWNER and for a superuser as well", async () => {
    const { collectionName } = await seed({ name: "s.txt", protection: "secret", ownerSub: "user:owner" });

    verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
    expect((await get(`/api/preview/f/${collectionName}/s.txt`, { authorization: "Bearer t" })).statusCode).toBe(404);

    verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true } as never);
    expect((await get(`/api/preview/f/${collectionName}/s.txt`, { authorization: "Bearer t" })).statusCode).toBe(404);
  });

  it("GET /api/preview/t/:token works for a secret file and never sets a cookie", async () => {
    const { linkToken } = await seed({ name: "x.txt", protection: "secret" });
    const res = await get(`/api/preview/t/${linkToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  // --- Effective protection (D-96) - the landmine: STORED protection is never safe to read directly ----

  it("a public file inside a private collection: 200 at /f/, but only the minimal head, no OG, no embedded context (D-96/D-72)", async () => {
    // D-96/D-99: private still RESOLVES at the readable path (unlike secret) - it just reveals nothing,
    // exactly like a file stored private itself.
    const { collectionName } = await seed({
      name: "leak-check.txt",
      protection: "public",
      collectionProtection: "private",
    });
    const res = await get(`/f/${collectionName}/leak-check.txt`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("og:");
    expect(res.body).not.toContain("leak-check.txt");
    expect(res.body).not.toContain("preview-context");
  });

  it("a public file inside a secret collection also 404s at its readable path (secret never resolves)", async () => {
    const { collectionName } = await seed({
      name: "leak-check2.txt",
      protection: "public",
      collectionProtection: "secret",
    });
    expect((await get(`/f/${collectionName}/leak-check2.txt`)).statusCode).toBe(404);
  });

  it("a secret-gated file's own /t/<token> reveals the full document with no auth needed (D-96/D-100)", async () => {
    // secret, unlike private, reveals fully once reached by its unguessable token - only the READABLE
    // path is hidden (D-59). This is what makes the collection-gated file usable at all without an owner
    // session.
    const { linkToken } = await seed({
      name: "leak-check3.txt",
      protection: "public",
      collectionProtection: "secret",
    });
    const res = await get(`/t/${linkToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("leak-check3.txt");
  });

  it("GET /api/preview/f/<path> for a file gated only by its collection is 404 anonymously, and a collection-name leak check", async () => {
    const { collectionName, collectionId } = await seed({
      name: "leak-check4.txt",
      protection: "public",
      collectionProtection: "private",
    });
    const res = await get(`/api/preview/f/${collectionName}/leak-check4.txt`);
    expect(res.statusCode).toBe(404);
    // D-100: nothing about a collection-gated file's OWN previewUrl/directUrl may name its collection -
    // checked positively via the token API below, which is what the file's copy control actually offers.
    expect(collectionId).toEqual(expect.any(String));
  });

  it("GET /api/preview/t/<token> for a collection-gated file never exposes the collection's name (D-100)", async () => {
    const { collectionName, linkToken } = await seed({
      name: "leak-check5.txt",
      protection: "public",
      collectionProtection: "secret",
    });
    const res = await get(`/api/preview/t/${linkToken}`);
    expect(res.statusCode).toBe(200);
    const ctx = res.json() as PreviewContext;
    expect(ctx.previewUrl).not.toContain(collectionName);
    expect(ctx.directUrl).not.toContain(collectionName);
    expect(ctx.previewUrl).toContain(`/t/${linkToken}`);
    expect(JSON.stringify(ctx)).not.toContain(collectionName);
  });

  it("reports the EFFECTIVE protection for a collection-gated file, never the stored column (D-96)", async () => {
    // The file is stored `public`; its collection is `secret`, so its effective level is `secret` and
    // D-97 leaves the stored column alone. Answering "public" here is the D-96 landmine reaching the wire:
    // the owner's own preview page renders this value verbatim ("You own this file (public)." -
    // PreviewCard.tsx) and offers it as the protection selector's current state, both of which would then
    // be claiming a gated file is publicly listed.
    const { linkToken } = await seed({
      name: "effective-level.txt",
      protection: "public",
      collectionProtection: "secret",
    });
    const res = await get(`/api/preview/t/${linkToken}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as PreviewContext).protection).toBe("secret");
  });

  it("the owner still reaches a file gated only by its collection, via /api/preview/t/<token> (D-99)", async () => {
    const { linkToken } = await seed({
      name: "owner-reach.txt",
      protection: "public",
      collectionProtection: "private",
      ownerSub: "user:owner",
    });
    verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
    const res = await get(`/api/preview/t/${linkToken}`, { authorization: "Bearer t" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as PreviewContext).isOwner).toBe(true);
  });

  it("a grantee on the collection (not the file) reaches an otherwise-private file inside a private collection (D-99)", async () => {
    const { collectionId, linkToken } = await seed({
      name: "collection-grant.txt",
      protection: "private",
      collectionProtection: "private",
      ownerSub: "user:owner",
    });
    const grantedSub = `user:${randomUUID()}`;
    await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
      collectionId,
      grantedSub,
    ]);
    verifyMock.mockResolvedValue({ sub: grantedSub } as never);
    const res = await get(`/api/preview/t/${linkToken}`, { authorization: "Bearer t" });
    expect(res.statusCode).toBe(200);
  });

  // --- oEmbed (D-74) --------------------------------------------------------------------------------

  it("GET /api/oembed returns oEmbed 1.0 JSON for a public image, type photo with dimensions", async () => {
    const { collectionName } = await seed({ name: "photo.png", protection: "public", width: 640, height: 480 });
    const previewUrl = `https://${FILES_HOST}/f/${collectionName}/photo.png`;

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

  // Review session 034: E5's unfurl half repointed og:image/twitter:image at the thumbnail (Wave B2) so
  // consumers stop pulling the multi-MB original - and left oEmbed's own `thumbnail_url`, the field
  // literally named "thumbnail", pointing at that original.
  it("GET /api/oembed advertises the THUMBNAIL as thumbnail_url when one exists (D-137)", async () => {
    const { collectionName, fileId } = await seed({
      name: "photo.png",
      protection: "public",
      width: 640,
      height: 480,
    });
    await getPool().query("UPDATE files SET thumb_name = ? WHERE id = ?", [`${fileId}-thumb.webp`, fileId]);
    const previewUrl = `https://${FILES_HOST}/f/${collectionName}/photo.png`;

    const res = await get(`/api/oembed?url=${encodeURIComponent(previewUrl)}&format=json`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thumbnail_url).toContain("/thumb/");
    expect(body.thumbnail_url).not.toBe(body.url); // never the full original any more
  });

  it("GET /api/oembed still falls back to directUrl as thumbnail_url for a pre-E5 file (D-138)", async () => {
    const { collectionName } = await seed({ name: "old.png", protection: "public", width: 640, height: 480 });
    const previewUrl = `https://${FILES_HOST}/f/${collectionName}/old.png`;

    const body = (await get(`/api/oembed?url=${encodeURIComponent(previewUrl)}`)).json();
    expect(body.thumbnail_url).toBe(body.url);
  });

  it("GET /api/oembed falls back to type link for a non-image kind", async () => {
    const { collectionName } = await seed({ name: "notes.txt", protection: "public" });
    const previewUrl = `https://${FILES_HOST}/f/${collectionName}/notes.txt`;

    const res = await get(`/api/oembed?url=${encodeURIComponent(previewUrl)}`);
    expect((res.json() as { type: string }).type).toBe("link");
  });

  it("GET /api/oembed 404s for a private file, an unknown file, and a url outside this origin", async () => {
    const { collectionName } = await seed({ name: "x.txt", protection: "private", ownerSub: "user:owner" });
    const privateUrl = `https://${FILES_HOST}/f/${collectionName}/x.txt`;
    expect((await get(`/api/oembed?url=${encodeURIComponent(privateUrl)}`)).statusCode).toBe(404);

    const unknownUrl = `https://${FILES_HOST}/f/never-${randomUUID()}/x.txt`;
    expect((await get(`/api/oembed?url=${encodeURIComponent(unknownUrl)}`)).statusCode).toBe(404);

    const foreignUrl = "https://evil.example/f/whatever";
    expect((await get(`/api/oembed?url=${encodeURIComponent(foreignUrl)}`)).statusCode).toBe(404);

    expect((await get("/api/oembed")).statusCode).toBe(404);
  });

  // --- E4.1 Wave A / D-107: a collection's own share link (closes E4-COLLECTION-TOKEN-UNRESOLVED) -------
  //
  // Token uniqueness is enforced across BOTH tables by storage/db.ts's isLinkTokenTaken (checked before
  // this suite was written), so a real file/collection token collision cannot occur - "a file token wins"
  // (§1.1) is defensive ordering in the dispatcher, not something a live collision test could exercise.

  function embeddedLocationOf(body: string): CollectionLocation & { embeddedFor: string } {
    const match = /<script type="application\/json" id="preview-context">(.*?)<\/script>/.exec(body);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]) as CollectionLocation & { embeddedFor: string };
  }

  describe("a collection's previewUrl resolves in both shapes (the test whose absence let this ship)", () => {
    it("a public collection's /f/<path> 200s with an embedded CollectionLocation", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `pub-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      const res = await get(`/f/${collection.name}`);

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      // React's renderToString HTML-escapes text content (the site name's apostrophe becomes &#x27;),
      // so this checks for the title element rather than a literal "Hannah's" substring.
      expect(res.body).toMatch(new RegExp(`<title>${collection.name} · Hannah&#x27;s File Drop</title>`));
      const location = embeddedLocationOf(res.body);
      expect(location).toEqual({ kind: "collection", collectionId: collection.id, embeddedFor: `/f/${collection.name}` });
    });

    it("the SAME public collection's /t/<token> also 200s with the same CollectionLocation", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `pubtok-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      const res = await get(`/t/${collection.linkToken}`);

      expect(res.statusCode).toBe(200);
      expect(embeddedLocationOf(res.body)).toEqual({
        kind: "collection",
        collectionId: collection.id,
        embeddedFor: `/t/${collection.linkToken}`,
      });
    });

    it("a nested collection resolves by its full path", async () => {
      const top = await createCollection({
        parentId: "",
        name: `nest-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      const child = await createCollection({
        parentId: top.id,
        name: "child",
        ownerSub: "user:owner",
        protection: "public",
      });
      const res = await get(`/f/${top.name}/child`);
      expect(res.statusCode).toBe(200);
      expect(embeddedLocationOf(res.body)).toEqual({
        kind: "collection",
        collectionId: child.id,
        embeddedFor: `/f/${top.name}/child`,
      });
    });

    it("an unknown collection path/token still 404s (no regression on the file-not-found case)", async () => {
      expect((await get(`/f/never-${randomUUID()}`)).statusCode).toBe(404);
      expect((await get(`/t/${randomUUID()}`)).statusCode).toBe(404);
    });
  });

  // Mandatory, never-delete class (verification-concept.md): a secret collection's readable path 404s for
  // everyone including its owner and a superuser; its /t/<token> still resolves; an anonymous request for
  // ANY non-public collection 404s. Neither response leaks the collection name (D-100).
  describe("collection effective-protection gating (D-96/D-99, mandatory/never-delete)", () => {
    it("secret: 404 at /f/<path> for anonymous, the owner, AND a superuser - but /t/<token> resolves", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `secret-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "secret",
      });

      const anon = await get(`/f/${collection.name}`);
      expect(anon.statusCode).toBe(404);
      expect(anon.body).not.toContain(collection.name);

      verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
      expect((await get(`/f/${collection.name}`, { authorization: "Bearer t" })).statusCode).toBe(404);

      verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true } as never);
      expect((await get(`/f/${collection.name}`, { authorization: "Bearer t" })).statusCode).toBe(404);

      const byToken = await get(`/t/${collection.linkToken}`);
      expect(byToken.statusCode).toBe(200);
      expect(embeddedLocationOf(byToken.body)).toEqual({
        kind: "collection",
        collectionId: collection.id,
        embeddedFor: `/t/${collection.linkToken}`,
      });
    });

    it("private: anonymous 404s at the readable path (unlike a file, which reveals nothing but still 200s)", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `private-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "private",
      });
      const res = await get(`/f/${collection.name}`);
      expect(res.statusCode).toBe(404);
    });

    // AC6/D-124 (E4.1 live-testing findings, Wave B): the exact reproduction of finding 4 - a collection's
    // readable path 404d cold even though its own token (and its own browse listing) already 200d. The
    // link shape IS the credential for unlisted, same as it already is for a file (D-59: "not listed, but
    // the link works for anyone who has it").
    it("unlisted: a COLD, client-free anonymous GET at the readable path 200s with an embedded CollectionLocation (D-124)", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `unlisted-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "unlisted",
      });
      const res = await get(`/f/${collection.name}`);
      expect(res.statusCode).toBe(200);
      expect(embeddedLocationOf(res.body)).toEqual({
        kind: "collection",
        collectionId: collection.id,
        embeddedFor: `/f/${collection.name}`,
      });
    });

    it("private: the owner and a superuser CAN reach it at the readable path", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `priv-owner-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "private",
      });

      verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
      const ownerRes = await get(`/f/${collection.name}`, { authorization: "Bearer t" });
      expect(ownerRes.statusCode).toBe(200);
      expect(embeddedLocationOf(ownerRes.body)).toEqual({
        kind: "collection",
        collectionId: collection.id,
        embeddedFor: `/f/${collection.name}`,
      });

      verifyMock.mockResolvedValue({ sub: "user:root", mosni_owner: true } as never);
      expect((await get(`/f/${collection.name}`, { authorization: "Bearer t" })).statusCode).toBe(200);
    });

    it("private: a signed-in stranger with no grant still 404s", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `priv-stranger-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "private",
      });
      verifyMock.mockResolvedValue({ sub: "user:stranger" } as never);
      expect((await get(`/f/${collection.name}`, { authorization: "Bearer t" })).statusCode).toBe(404);
    });

    it("private: an ACL grant on the collection itself grants access (D-99)", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `priv-granted-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "private",
      });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        collection.id,
        "user:granted",
      ]);
      verifyMock.mockResolvedValue({ sub: "user:granted" } as never);
      expect((await get(`/f/${collection.name}`, { authorization: "Bearer t" })).statusCode).toBe(200);
    });

    it("private: an ACL grant on an ANCESTOR collection pierces down (D-99)", async () => {
      const top = await createCollection({
        parentId: "",
        name: `priv-anc-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "private",
      });
      const child = await createCollection({
        parentId: top.id,
        name: "child",
        ownerSub: "user:owner",
        protection: "private",
      });
      await getPool().query("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [
        top.id,
        "user:granted",
      ]);
      verifyMock.mockResolvedValue({ sub: "user:granted" } as never);
      const res = await get(`/f/${top.name}/child`, { authorization: "Bearer t" });
      expect(res.statusCode).toBe(200);
      expect(embeddedLocationOf(res.body)).toEqual({
        kind: "collection",
        collectionId: child.id,
        embeddedFor: `/f/${top.name}/child`,
      });
    });

    it("a collection nested under a secret ancestor also 404s at its own readable path (secret never resolves, D-96)", async () => {
      const top = await createCollection({
        parentId: "",
        name: `sec-anc-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "secret",
      });
      const child = await createCollection({
        parentId: top.id,
        name: "child",
        ownerSub: "user:owner",
        protection: "public", // own level is public - the ANCESTOR's secret must still win (D-96)
      });
      expect((await get(`/f/${top.name}/child`)).statusCode).toBe(404);
      // and never leaks the child's own name either
      const res = await get(`/f/${top.name}/child`);
      expect(res.body).not.toContain(child.name);
    });
  });

  // E4.1 Wave C: GET /api/preview/f|t/* needs the SAME file-then-collection fallback the document routes
  // got in Wave A - this is what a client-side navigation (or a back/forward Router doesn't reload the
  // document for) resolves through, since there is no embedded context to read on that path.
  describe("GET /api/preview/f|t/* resolves a collection too, same shape as the document route (E4.1 Wave C)", () => {
    it("GET /api/preview/f/<collection path> returns the CollectionLocation shape", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `ctxpub-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "public",
      });
      const res = await get(`/api/preview/f/${collection.name}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: "collection", collectionId: collection.id });
    });

    it("GET /api/preview/t/<collection token> returns the same shape, even for a secret collection", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `ctxsec-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "secret",
      });
      const res = await get(`/api/preview/t/${collection.linkToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: "collection", collectionId: collection.id });
    });

    it("GET /api/preview/f/<unlisted collection's readable path> 200s anonymously, same as the document (D-124)", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `ctxunl-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "unlisted",
      });
      const res = await get(`/api/preview/f/${collection.name}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: "collection", collectionId: collection.id });
    });

    it("GET /api/preview/f/<secret collection's readable path> 404s (same gate as the document)", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `ctxsec2-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "secret",
      });
      expect((await get(`/api/preview/f/${collection.name}`)).statusCode).toBe(404);
    });

    it("GET /api/preview/f/<private collection's path> 404s for anonymous, 200 for the owner (D-99)", async () => {
      const collection = await createCollection({
        parentId: "",
        name: `ctxpriv-${randomUUID()}`,
        ownerSub: "user:owner",
        protection: "private",
      });
      expect((await get(`/api/preview/f/${collection.name}`)).statusCode).toBe(404);

      verifyMock.mockResolvedValue({ sub: "user:owner" } as never);
      const res = await get(`/api/preview/f/${collection.name}`, { authorization: "Bearer t" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: "collection", collectionId: collection.id });
    });

    it("a file token still wins over a collection token (§1.1 file-then-collection ordering)", async () => {
      const { linkToken } = await seed({ name: "wins.txt", protection: "public" });
      const res = await get(`/api/preview/t/${linkToken}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { name?: string; kind?: string };
      expect(body.kind).not.toBe("collection");
      expect(body.name).toBe("wins.txt");
    });
  });
});
