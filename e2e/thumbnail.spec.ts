import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";
import sharp from "sharp";

// E7-QA1 round 3 (Hannah): a file's thumbnail rendered as the browser's built-in broken-image icon in the
// listing, while the preview page showed the same file correctly. Reported as a webp problem; the file
// TYPE turned out to be a red herring - Hannah narrowed it herself by flipping the file to `unlisted` to
// share it, which fixed it. The real axis is PROTECTION: a `private` file's listing thumbnail was broken.
//
// Root cause: for `private`, buildThumbUrl() returns the plain-path URL (readablePathResolves() is true
// for everything except `secret`), and /thumb/<path> runs authorizePrivate(). dl.mosni.dev has no session
// to authorize with - D-33 forbids a cookie on that origin, and a plain `<img src>` cannot carry a Bearer
// - so the request could never succeed. The preview page never hit this because it swaps in a D-84 SIGNED
// URL (controllers/preview.ts's withSignedDirectUrl); the browse listing simply never got one.
//
// Thumbnails had NO browser-tier coverage at all before this file - `grep -r thumb e2e/` was empty - and
// the two axes that mattered (a real browser, and protection) were exactly the ones no other tier could
// see. The app's own integration tests were green throughout, because the app's response IS correct in
// isolation: it is a 401 on a request that no browser could ever have authorized.
const STORAGE_ROOT = "/data/storage";
const FILES_ORIGIN = "https://files-e2e.test";
const DL_ORIGIN = "https://dl.mosni.dev";
const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";

type Protection = "public" | "unlisted" | "secret" | "private";

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

interface Seeded {
  collectionId: string;
  collectionName: string;
  name: string;
  ownerSub: string;
}

// A real, decodable 512x341 webp - the shape storage/thumbs.ts leaves behind. Real bytes matter here
// because a browser is the assertion: it rejects a placeholder string no matter how correct delivery is.
async function realThumbBytes(): Promise<Buffer> {
  return sharp({ create: { width: 512, height: 341, channels: 3, background: { r: 40, g: 90, b: 140 } } })
    .webp()
    .toBuffer();
}

async function seed(opts: { name: string; protection: Protection; ownerSub?: string }): Promise<Seeded> {
  const collectionId = newId();
  const fileId = newId();
  const collectionName = `thumbs-${randomUUID().slice(0, 8)}`;
  const diskDir = "2026/07";
  const diskName = `${fileId}-${opts.name}`;
  const thumbName = `${fileId}-thumb.webp`;
  const ownerSub = opts.ownerSub ?? "user:e2e-thumb";

  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "e2e thumbnail fixture source bytes");
  await writeFile(path.join(STORAGE_ROOT, diskDir, thumbName), await realThumbBytes());

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  try {
    // The COLLECTION stays public so the file's own protection is the only variable under test - an
    // effective level inherited from the parent would confound every row here (D-96).
    await conn.execute(
      "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection, link_token) VALUES (?, '', ?, ?, 'public', ?)",
      [collectionId, collectionName, ownerSub, randomUUID().replace(/-/g, "").slice(0, 5)],
    );
    await conn.execute(
      `INSERT INTO files
        (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, width, height,
         owner_sub, uploader_sub, uploader_name, thumb_name)
        VALUES (?, ?, ?, ?, ?, 33, ?, ?, 'committed', 1200, 800, ?, ?, NULL, ?)`,
      [
        fileId,
        collectionId,
        opts.name,
        diskDir,
        diskName,
        opts.protection,
        randomUUID().replace(/-/g, "").slice(0, 5),
        ownerSub,
        ownerSub,
        thumbName,
      ],
    );
  } finally {
    await conn.end();
  }
  return { collectionId, collectionName, name: opts.name, ownerSub };
}

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string): Promise<string> {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=files:write`);
  expect(res.ok(), "mock-idp must mint a token").toBeTruthy();
  return (await res.json()).token as string;
}

// The listing's OWN answer for a row - the exact `thumbUrl` string a real browser would put in an <img>.
// Going through the API rather than constructing the URL here is the point: the bug was in what the
// server handed the client, so a test that builds its own URL would have passed while the app was broken.
async function thumbUrlFromListing(
  request: import("@playwright/test").APIRequestContext,
  seeded: Seeded,
  token?: string,
): Promise<string | null> {
  const res = await request.get(`${FILES_ORIGIN}/api/browse?scope=visible&collectionId=${seeded.collectionId}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  expect(res.status(), "the listing must load").toBe(200);
  const body = await res.json();
  const row = body.files.find((f: { name: string }) => f.name === seeded.name);
  expect(row, `the seeded file must appear in the listing`).toBeTruthy();
  return row.thumbUrl;
}

// Loads a URL as a real <img> from a document on the files. origin, so the page's own CSP governs it just
// as it does in the listing. Only non-zero dimensions prove the browser got usable image bytes - a CSP
// refusal, a 401 and a 404 are indistinguishable to the user, all three being the broken-image icon.
async function loadsAsImage(page: import("@playwright/test").Page, url: string) {
  await page.goto(`${FILES_ORIGIN}/`);
  return page.evaluate(
    (src) =>
      new Promise<{ ok: boolean; width: number; height: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
        img.src = src;
      }),
    url,
  );
}

// Hannah's exact comparison: same file, same everything, only the protection level differs. `private` is
// the regression; the other two are the controls that were already working and must stay working.
for (const protection of ["public", "unlisted", "private"] as const) {
  test(`a ${protection} file's listing thumbnail loads in a real browser`, async ({ page, request }) => {
    const ownerSub = `user:e2e-${randomUUID().slice(0, 8)}`;
    const seeded = await seed({ name: "shot.webp", protection, ownerSub });
    // A `private` row is only listed to an identity that may read it, so this listing is fetched as its
    // owner - exactly the situation Hannah was in when she saw the broken image.
    const token = protection === "private" ? await mintToken(request, ownerSub) : undefined;

    const thumbUrl = await thumbUrlFromListing(request, seeded, token);
    expect(thumbUrl, "a file with a thumbnail must expose a thumbUrl").not.toBeNull();

    const loaded = await loadsAsImage(page, thumbUrl!);
    expect(loaded.ok, `a ${protection} file's thumbnail must decode, not render as a broken image`).toBe(true);
    expect(loaded.width).toBe(512);
    expect(loaded.height).toBe(341);
  });
}

// The mechanism, pinned separately from the symptom: `private` must be handed the SIGNED form, because
// that is the only one an unauthenticated <img> can ever satisfy. Asserting the shape means a future
// change that silently reverts to /thumb/<path> fails here even if some other layer happens to mask it.
test("a private file's listing thumbUrl is the signed form, not the path form", async ({ request }) => {
  const ownerSub = `user:e2e-${randomUUID().slice(0, 8)}`;
  const seeded = await seed({ name: "signed.webp", protection: "private", ownerSub });
  const token = await mintToken(request, ownerSub);

  const thumbUrl = await thumbUrlFromListing(request, seeded, token);

  expect(thumbUrl).toContain("/thumb/s/");
  expect(thumbUrl).toMatch(/[?&]exp=\d+/);
  expect(thumbUrl).toMatch(/[?&]sig=/);
  // The bytes must come back with NO credentials at all - that is the entire point of signing.
  const res = await request.get(thumbUrl!, { headers: { host: "dl.mosni.dev" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/webp");
  expect(res.headers()["x-content-type-options"], "nosniff must survive X-Accel-Redirect").toBe("nosniff");
});

// The same defect hit `directUrl`, which the client-side archive ("Download all") fetches per file - a
// private file would have failed there too, silently producing an incomplete zip.
test("a private file's listing directUrl is signed too, so the archive can actually fetch it", async ({
  request,
}) => {
  const ownerSub = `user:e2e-${randomUUID().slice(0, 8)}`;
  const seeded = await seed({ name: "archive-me.webp", protection: "private", ownerSub });
  const token = await mintToken(request, ownerSub);

  const res = await request.get(`${FILES_ORIGIN}/api/browse?scope=visible&collectionId=${seeded.collectionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const row = (await res.json()).files.find((f: { name: string }) => f.name === seeded.name);

  expect(row.directUrl).toContain("/s/");
  const bytes = await request.get(row.directUrl, { headers: { host: "dl.mosni.dev" } });
  expect(bytes.status(), "an unauthenticated archive fetch must succeed on a signed URL").toBe(200);
});

// A `secret` file is deliberately NOT signed - it keeps the unguessable-token URL, and its whole point is
// that the token is the credential. Guards against "fix private by signing everything".
test("a secret file's listing thumbnail still uses its token URL, not a signature", async ({ request }) => {
  const ownerSub = `user:e2e-${randomUUID().slice(0, 8)}`;
  const seeded = await seed({ name: "hidden.webp", protection: "secret", ownerSub });
  // Listed as its OWNER: a `secret` file is deliberately absent from an anonymous listing (that is the
  // level's entire purpose - it is reachable only through its unguessable token), so an anonymous fetch
  // here would find no row to assert on.
  const token = await mintToken(request, ownerSub);

  const thumbUrl = await thumbUrlFromListing(request, seeded, token);

  expect(thumbUrl).toContain("/thumb/t/");
  expect(thumbUrl).not.toContain("/thumb/s/");
  const res = await request.get(thumbUrl!, { headers: { host: "dl.mosni.dev" } });
  expect(res.status()).toBe(200);
});
