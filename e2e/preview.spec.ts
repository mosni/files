import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ensureSharedDir } from "./seedStorage.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// D-70 Wave D. Uploading is not reachable without a live IdP (same limitation
// upload-delivery.spec.ts documents), so fixtures are seeded directly: write the bytes at the exact path
// app-e2e will stat() - shared via the `e2e-storage` volume in docker-compose.verify.yml - and insert the
// matching row straight into the real mariadb service both containers share.
const STORAGE_ROOT = "/data/storage";
// `files-e2e.test`, NOT the real `files.mosni.dev` (docker-compose.verify.yml's app-e2e APP_ORIGIN for
// this tier only): `mosni.dev` is on Chromium's baked-in HSTS preload list, so a real browser silently
// upgrades any `http://files.mosni.dev/...` navigation to https:// and gets ERR_CONNECTION_REFUSED against
// this sandbox's plain-HTTP-only app-e2e (confirmed empirically - not fixable via any test-side config,
// since it's a policy baked into the Chromium binary itself). `.test` is IANA-reserved for testing
// (RFC 2606) and can never be preload-listed. `files-e2e.test` is a real DNS alias for this container on
// the compose network, so a real browser can navigate a genuine host-constrained route directly - no
// header spoofing needed (which Chromium separately rejects for real page navigations at every layer
// tried: browser.newContext's extraHTTPHeaders throws net::ERR_INVALID_ARGUMENT; page.route()'s CDP-level
// header rewrite is silently dropped for the main-frame navigation request specifically). app-e2e listens
// on port 80 in this compose tier specifically so the browser's Host header omits the port (Fastify's
// `constraints: { host }` is an exact string match against the bare hostname) - mirroring how production
// omits 443 for HTTPS.
//
// E5.1 Wave H (D-162): the SCHEME changed from http to https - nginx-e2e now terminates real TLS (a
// self-signed cert, `ignoreHTTPSErrors: true` in playwright.config.ts). `files-e2e.test` itself is
// unaffected by Chromium's HSTS preload list (that only ever applied to the real `mosni.dev`), so this is
// a pure scheme change, not a re-litigation of the paragraph above.
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `https://${FILES_HOST}`;

const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string) {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=files:write`);
  expect(res.ok(), "mock-idp must mint a token").toBeTruthy();
  return (await res.json()).token as string;
}

function newId(): string {
  // D-81's surrogate ids are base62, but any unique CHAR(16) string satisfies the schema - these fixtures
  // seed the DB directly (there is no live IdP here to drive a real upload through the app), so plain hex
  // is simplest.
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

// `relPath` keeps its old shape (`<collection-segment>/<filename>`) for every caller below - it is split
// into a collection (created fresh, root-level) and the file's own display name, both fed through the
// E3 schema directly (surrogate ids, disk_dir/disk_name, state='committed').
async function seed(opts: {
  relPath: string;
  protection?: "public" | "unlisted" | "secret" | "private";
  width?: number;
  height?: number;
  // E5.1 Wave H (H6): owner/uploader identity, so a seeded fixture can exercise the SAME owner-only
  // surfaces (rename, protection, delete, the uploader block) a real upload would - previously every
  // fixture here was ownerless, so nothing in this file could ever render them.
  ownerSub?: string;
  uploaderSub?: string;
  uploaderName?: string;
  // H3: a real fixture's bytes, when the test needs the browser to actually decode something (the
  // placeholder text default is fine for every test that only asserts metadata/markup).
  bytes?: Buffer | string;
}): Promise<{ linkToken: string }> {
  const segments = opts.relPath.split("/");
  const name = segments[segments.length - 1]!;
  const collectionName = segments.slice(0, -1).join("/");

  const collectionId = newId();
  const fileId = newId();
  const diskDir = "2026/07";
  const diskName = `${fileId}-${name}`;
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  // D-98: collections now carry their own link_token too, sharing one unique-per-table namespace with
  // files - each fixture needs its own distinct one, or the second seed() call in a run collides on the
  // column's shared DEFAULT ''.
  const collectionLinkToken = randomUUID().replace(/-/g, "").slice(0, 5);

  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  // Review 060/SEC-2: shared-writable, because app-e2e writes this same directory as uid 1000.
  await ensureSharedDir(path.dirname(abs));
  await writeFile(abs, opts.bytes ?? "e2e preview fixture bytes");

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  try {
    await conn.execute(
      "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection, link_token) VALUES (?, '', ?, ?, 'unlisted', ?)",
      [collectionId, collectionName, opts.ownerSub ?? "user:e2e-fixture", collectionLinkToken],
    );
    await conn.execute(
      `INSERT INTO files
        (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, width, height,
         owner_sub, uploader_sub, uploader_name)
        VALUES (?, ?, ?, ?, ?, 25, ?, ?, 'committed', ?, ?, ?, ?, ?)`,
      [
        fileId,
        collectionId,
        name,
        diskDir,
        diskName,
        opts.protection ?? "public",
        linkToken,
        opts.width ?? null,
        opts.height ?? null,
        opts.ownerSub ?? null,
        opts.uploaderSub ?? null,
        opts.uploaderName ?? null,
      ],
    );
  } finally {
    await conn.end();
  }
  return { linkToken };
}

test("crawler simulation: the raw HTML carries OG/Twitter/oEmbed/JSON-LD tags with no JavaScript", async ({
  request,
}) => {
  const relPath = `e2e-crawler-${randomUUID()}/photo.png`;
  await seed({ relPath, width: 640, height: 480 });

  // request.get() is Playwright's plain HTTP API context - no browser, no JS execution. This is the
  // automated stand-in for "does it unfurl", and the whole reason the head is server-rendered at all.
  const res = await request.get(`/f/${relPath}`, { headers: { host: FILES_HOST } });
  expect(res.status()).toBe(200);
  const body = await res.text();

  expect(body).toContain('property="og:title" content="photo.png"');
  expect(body).toContain('property="og:image"');
  expect(body).toContain('property="og:image:width" content="640"');
  expect(body).toContain('name="twitter:card" content="summary_large_image"');
  expect(body).toContain('rel="canonical"');
  expect(body).toContain("application/json+oembed");
  expect(body).toContain("application/ld+json");
});

test("browser: the SPA mounts and paints the file name and copy fields from the embedded context", async ({
  page,
}) => {
  const relPath = `e2e-browser-${randomUUID()}/photo.png`;
  await seed({ relPath, width: 640, height: 480 });

  await page.goto(`${FILES_ORIGIN}/f/${relPath}`);

  await expect(page.locator("h1")).toHaveText("photo.png");
  await expect(page.locator(".copy-field-primary input")).toHaveValue(
    `https://${FILES_HOST}/f/${relPath}`,
  );
});

test("no CSP violation is raised loading a PDF preview (guards Wave C5's frame-src fix)", async ({
  page,
}) => {
  const relPath = `e2e-pdf-${randomUUID()}/doc.pdf`;
  await seed({ relPath });

  // Scoped to framing violations specifically, not "any CSP notice on the page" - mosnicat.js (the
  // design-system chrome, loaded unconditionally and out of this pass's scope) separately tries to load a
  // favicon-ish image from the bare mosni.dev domain and gets blocked by img-src, which is real but
  // unrelated pre-existing noise this test must not trip on.
  //
  // SCOPE, stated plainly so nobody trusts this further than it goes: this guards `frame-src` only, which
  // the PARENT document enforces at request time. It canNOT guard `frame-ancestors`, which only the CHILD
  // response can violate. The frame-ancestors half of the fix is covered by the header assertion in
  // app/test/integration/security-headers.test.ts (and, since the E5/E5.1 review, by an assertion on BOTH
  // the embed route and an ordinary route in app/test/integration/embed.test.ts - defect 1, session 037).
  // ⚠ Corrected E5.1 Wave H (D-162): this comment used to say the dl.mosni.dev child could never load here
  // because this network had no TLS listener for it - that stopped being true the moment nginx-e2e gained
  // one. The iframe genuinely attempts to load `https://dl.mosni.dev` now; this test still only asserts
  // that no CSP violation is raised, not that the byte fetch itself succeeds (that is
  // e2e/upload-flow.spec.ts's job, against files-e2e.test's own dl. alias).
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      /Content Security Policy/i.test(msg.text()) &&
      /frame-src|frame-ancestors|Framing/i.test(msg.text())
    ) {
      cspViolations.push(msg.text());
    }
  });

  await page.goto(`${FILES_ORIGIN}/f/${relPath}`);
  await page.locator("iframe").waitFor({ state: "attached" });
  await page.waitForTimeout(500);

  expect(cspViolations).toEqual([]);
});

// E5.1 Wave H (H6): the measured reason finding 5 (D-164) shipped - `preview.spec.ts` had ZERO
// `window.mosni` stubs and ZERO tokens, so the preview page was never exercised signed in, and D-164's
// teardown only happens on the OWNER's Bearer re-fetch (a signed-out visitor never triggers the extra
// render that broke it). This is the regression test for that: it must be proved red against a deliberate
// revert of VideoPreview.tsx's memoised `src` before it counts (done manually this session, not committed
// - see the session log for the transcript), and it also covers the other owner-only surfaces (AC10's
// uploader block, rename, protection, delete) that live on this exact page and were equally unexercised.
test("owner, signed in: the uploader block, rename, protection and delete all render, and a real video survives the post-mount Bearer re-fetch (H6, D-164 regression)", async ({
  page,
  request,
}) => {
  const sub = `user:e2e-preview-owner-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const relPath = `e2e-owner-${randomUUID()}/clip.webm`;
  // The same real, small VP9 fixture e2e/video-playback.spec.ts uses (H3) - Playwright's bundled Chromium
  // has no H.264 decoder at all, so a real codec is required for `readyState` to ever reach HAVE_CURRENT_
  // DATA; a placeholder buffer would prove nothing about whether the player actually decodes anything.
  const fixtureBytes = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "clip.webm"),
  );
  await seed({ relPath, ownerSub: sub, uploaderSub: sub, uploaderName: "E2E Owner", bytes: fixtureBytes });

  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(`
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => ({ sub: ${JSON.stringify(sub)}, roles: ["files:write"] }),
      token: () => ${JSON.stringify(token)},
      onChange: (cb) => cb({ sub: ${JSON.stringify(sub)}, roles: ["files:write"] }),
      login: () => {}, logout: () => {},
      toast: () => {},
    });
  `);

  await page.goto(`${FILES_ORIGIN}/f/${relPath}`);

  // AC10 / the uploader block: a captured name renders, signed in as the owner who has one.
  await expect(page.getByText("E2E Owner")).toBeVisible({ timeout: 10_000 });
  // Owner-only surfaces (D-89/ManageControls, PreviewCard's header): rename, delete, protection.
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete file" })).toBeVisible();
  await expect(page.getByLabel("Who can access this")).toBeVisible();

  // D-164 regression: Preview.tsx's owner branch re-fetches the context WITH a Bearer after the initial
  // anonymous mount - exactly the extra render that tore the player down when `src` was an inline object
  // literal (a new identity every render). If this regresses, the player collapses to an empty
  // `<media-player>` with no `<video>` at all, and the two assertions below fail.
  const video = page.locator("video");
  await expect(video).toBeAttached({ timeout: 15_000 });
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  const box = await video.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(64); // rules out the D-164 "reports ready but collapses" mode
});
