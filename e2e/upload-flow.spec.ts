import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// THE product invariant, finally executed end to end: open -> drop -> copy a link that works (D-1).
//
// Until session 010 this had never run, by a test or by a person. The server's tus lifecycle was covered
// (app/test/integration/upload.test.ts) and the drop zone was covered against a mocked tus-js-client
// (web/test/unit/DropZone.test.tsx), and NOTHING joined the two - so E2 "Upload core" was marked complete
// on the strength of two halves that had never met. What unblocked this is e2e/mock-idp.mjs: a real RS256
// issuer, so the app's own unmodified verify() accepts a real token. Nothing here is stubbed or bypassed
// on the server side.
//
// Runs against the REAL production image (app-e2e, Dockerfile), real MariaDB, real redis.

const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";
// files-e2e.test now resolves to the REAL nginx.conf in front of the app (nginx-e2e in the compose file),
// so these flows traverse the deployed topology - location precedence, client_max_body_size, buffering,
// the X-Forwarded-* headers - instead of hitting the container directly. That is what would have caught
// the two production bugs (http:// Location, and a 413 on every chunk) before they reached the box.
// E5.1 Wave H (D-162): https, not http - nginx-e2e now terminates real TLS for this tier.
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `https://${FILES_HOST}`;
// app-direct.test reaches the container WITHOUT nginx, for the one assertion below that must control the
// X-Forwarded-* headers itself rather than let a real proxy set them (D-76's regression test wants to
// prove the APP correctly TRUSTS and uses a forwarded https scheme, which is a distinct thing from nginx
// now genuinely terminating TLS - see that test's own updated comment).
const APP_DIRECT_ORIGIN = "http://app-direct.test";
const STORAGE_ROOT = "/data/storage";

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string, roles = "files:write") {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=${encodeURIComponent(roles)}`);
  expect(res.ok(), "mock-idp must mint a token").toBeTruthy();
  return (await res.json()).token as string;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

// The full tus create + PATCH dance, through real nginx - the same sequence the first test performs
// inline (kept inline there, since its own assertions step through each stage). Returns the completing
// PATCH's JSON body.
async function completeUpload(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  filename: string,
  body: Buffer,
): Promise<{ previewUrl: string; directUrl: string }> {
  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
    },
  });
  expect(create.status()).toBe(201);
  const uploadUrl = new URL(create.headers()["location"], FILES_ORIGIN);
  const patch = await request.patch(`${FILES_ORIGIN}${uploadUrl.pathname}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    data: body,
  });
  expect(patch.status()).toBe(200);
  return (await patch.json()) as { previewUrl: string; directUrl: string };
}

test("a real authorized tus upload lands the bytes, and the returned link serves them back", async ({
  request,
}) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `upload-${randomUUID().slice(0, 8)}.txt`;
  const body = Buffer.from(`hello from the real upload flow ${randomUUID()}`);

  // --- create (through real nginx) ----------------------------------------------------------------
  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
    },
  });
  expect(create.status(), "authorized create must be accepted").toBe(201);

  const location = create.headers()["location"];
  expect(location, "tus must return a Location").toBeTruthy();

  // --- upload the bytes ---------------------------------------------------------------------------
  const uploadUrl = new URL(location, FILES_ORIGIN);
  const patch = await request.patch(`${FILES_ORIGIN}${uploadUrl.pathname}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    data: body,
  });
  expect(patch.status(), "the completing PATCH returns 200 with a body, not 204").toBe(200);

  const { previewUrl, directUrl } = (await patch.json()) as { previewUrl: string; directUrl: string };
  expect(previewUrl).toContain(filename);
  expect(directUrl).toContain(filename);

  const relPath = new URL(directUrl).pathname.replace(/^\//, "");

  // --- the bytes are really on disk, unchanged ----------------------------------------------------
  // D-81/D-82: the on-disk location is no longer derivable from the URL (it's `<YYYY>/<mm>/<id>-<original
  // filename>`, an internal detail the URL never mirrors) - so the disk_dir/disk_name are read back from
  // the database by the file's display name, exactly as the app itself resolves delivery.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  let diskRelPath: string;
  try {
    const [rows] = await conn.execute("SELECT disk_dir, disk_name FROM files WHERE name = ?", [filename]);
    const row = (rows as { disk_dir: string; disk_name: string }[])[0];
    expect(row, "the uploaded file's row must exist").toBeTruthy();
    diskRelPath = `${row!.disk_dir}/${row!.disk_name}`;
  } finally {
    await conn.end();
  }
  const onDisk = await readFile(path.join(STORAGE_ROOT, diskRelPath));
  expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
    createHash("sha256").update(body).digest("hex"),
  );

  // --- the preview link works ---------------------------------------------------------------------
  const preview = await request.get(`${FILES_ORIGIN}${new URL(previewUrl).pathname}`, {
    headers: { host: FILES_HOST },
  });
  expect(preview.status()).toBe(200);
  expect(await preview.text()).toContain(filename);

  // --- the direct link really delivers the bytes, through nginx's X-Accel-Redirect ----------------
  // This goes through the REAL dl. vhost (dl.mosni.dev now resolves to nginx-e2e), so it exercises the
  // whole D-5 path end to end: the app authorizes and returns an empty body with X-Accel-Redirect, and
  // NGINX serves the actual bytes from the internal-only location. Nothing had ever tested that nginx
  // serves what the app redirects to - only that the app set the header.
  const direct = await request.get(`https://dl.mosni.dev/${relPath}`);
  expect(direct.status()).toBe(200);
  expect(Buffer.from(await direct.body()).equals(body), "nginx must deliver the exact bytes").toBeTruthy();
  expect(direct.headers()["x-content-type-options"]).toBe("nosniff");
  expect(direct.headers()["referrer-policy"]).toBe("no-referrer");

  // D-135: ACAO must be set in nginx's `internal;` location, not on the Fastify reply - X-Accel-Redirect
  // drops app-set headers (the same trap nosniff/referrer-policy above already prove), so the integration
  // tier structurally cannot see this header at all. Exact value only, never a wildcard: a test that only
  // checked presence would pass on `*` just as easily as on the real origin.
  expect(direct.headers()["access-control-allow-origin"]).toBe("https://files.mosni.dev");
  expect(direct.headers()["access-control-allow-credentials"]).toBeUndefined();

  // E3 acceptance criterion 5 (A6/D-90): the DELIVERED bytes carry a Content-Type the APP chose from the
  // display name - not one nginx inferred from the on-disk extension. Only assertable here: per session
  // 010, the integration tier sees the app's own response, not what the client receives through the
  // X-Accel-Redirect hop. Under D-82 the disk name is the ORIGINAL filename, pinned forever, so a later
  // rename makes the two disagree permanently - the renameFile case below is what actually proves which
  // of the two is winning.
  //
  // ⚠ `; charset=utf-8` is part of the contract, not incidental: `contentTypeForRecord()` returns the
  // literal `text/plain; charset=utf-8` for any is-text record, and the charset is what stops a browser
  // from guessing an encoding for bytes it has been told not to interpret. Asserted in full for the same
  // reason the ACAO above is - a looser check (`toContain("text/plain")`) would also pass on a bare
  // `text/plain`, which is the value this stopped being five days before anyone noticed.
  expect(direct.headers()["content-type"]).toBe("text/plain; charset=utf-8");
});

test("delivery's Content-Type follows the DISPLAY name after a rename, not the pinned disk name (AC5/D-90)", async ({
  request,
}) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `ct-${randomUUID()}.bin`;
  // ⚠ BINARY bytes, and that is the whole reason this fixture exists. This test used to upload a `.txt`
  // and rename it to an unknown extension, which stopped proving anything on 2026-08-11 (edf6158):
  // `contentTypeForRecord()` now checks `record.isText` FIRST and returns `text/plain; charset=utf-8`
  // unconditionally for a text-detected file, deliberately, so a rename can never talk the app into
  // handing a renderable type to bytes a browser might interpret. An is-text record therefore answers
  // `text/plain` no matter what it is called - the display name cannot decide anything, so a text fixture
  // can no longer demonstrate D-90 at all. `isText` comes from the BYTES (lib/textDetect.ts), never the
  // filename, so a leading NUL is what makes this record non-text and puts the display name back in
  // charge. (The e2e tier is run at the end of a session rather than in `npm run verify`, which is how
  // this sat red for five days: the security change was right, the test was simply left behind.)
  const body = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x42]);

  const { previewUrl, directUrl } = await completeUpload(request, token, filename, body);

  // `.bin` is not on mime.ts's allowlist, so the fallback type - and the disk name is `.bin` too, pinned
  // forever by D-82. Nothing distinguishes app-decided from nginx-inferred yet.
  const before = await request.get(`https://dl.mosni.dev/${new URL(directUrl).pathname.replace(/^\//, "")}`);
  expect(before.status()).toBe(200);
  expect(before.headers()["content-type"]).toBe("application/octet-stream");

  // Rename to an extension mime.ts DOES know. The bytes never move (D-82), so the on-disk name is still
  // `.bin` - if nginx were the one deciding from the file on disk, this would stay octet-stream.
  const ctx = await (
    await request.get(`${FILES_ORIGIN}/api/preview${new URL(previewUrl).pathname}`, {
      headers: { host: FILES_HOST, authorization: `Bearer ${token}` },
    })
  ).json();
  const patched = await request.patch(`${FILES_ORIGIN}/api/files/${ctx.id}`, {
    headers: { host: FILES_HOST, authorization: `Bearer ${token}` },
    data: { name: `ct-${randomUUID()}.png` },
  });
  expect(patched.status()).toBe(200);

  const after = await request.get(
    `https://dl.mosni.dev/${new URL((await patched.json()).directUrl).pathname.replace(/^\//, "")}`,
  );
  expect(after.status()).toBe(200);
  // A named type rather than the fallback, so this asserts the display name actually DECIDED rather than
  // merely that the answer changed - `application/octet-stream` is what a lookup returns when it fails,
  // and a test whose "after" value is the failure value cannot tell the two apart.
  expect(after.headers()["content-type"]).toBe("image/png");
});

test("an upload larger than nginx's default body limit succeeds (the 413 regression Hannah hit)", async ({
  request,
}) => {
  // 2 MB in one PATCH - above nginx's DEFAULT client_max_body_size of 1m, below our chunk size, so a real
  // client sends it as a single body. On the box this 413'd on every chunk until nginx.conf set the limit.
  // Goes through real nginx precisely so that this assertion means something.
  const token = await mintToken(request, `user:e2e-${randomUUID()}`);
  const filename = `big-${randomUUID().slice(0, 8)}.bin`;
  const body = Buffer.alloc(2 * 1024 * 1024, 0x61);

  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
    },
  });
  expect(create.status()).toBe(201);

  const patch = await request.patch(
    `${FILES_ORIGIN}${new URL(create.headers()["location"], FILES_ORIGIN).pathname}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      data: body,
    },
  );
  expect(patch.status(), "a >1MB chunk must not be rejected by nginx").toBe(200);
});

test("behind a TLS-terminating proxy tus builds an https:// Location, never http:// (D-76 regression)", async ({
  request,
}) => {
  // The one case that must set the X-Forwarded-* headers itself: hitting the app DIRECTLY (bypassing
  // nginx-e2e) and sending exactly what production nginx sends proves the APP's own trust of a forwarded
  // scheme, independent of whichever proxy happens to be in front of it. (E5.1 Wave H gave nginx-e2e a
  // real TLS listener of its own - this test's point was never "nginx has no TLS here", it is "prove the
  // app respects X-Forwarded-Proto regardless of transport", which app-direct.test isolates cleanly.)
  // Without respectForwardedHeaders the app builds the Location from the raw request and returns http://,
  // which an https page's CSP blocks - the bug masked by helmet's upgrade-insecure-requests until D-76
  // removed it.
  const token = await mintToken(request, `user:e2e-${randomUUID()}`);
  const create = await request.post(`${APP_DIRECT_ORIGIN}/api/upload`, {
    headers: {
      host: FILES_HOST,
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": "5",
      "upload-metadata": `filename ${b64("scheme.txt")}`,
      "x-forwarded-proto": "https",
      "x-forwarded-host": FILES_HOST,
    },
  });
  expect(create.status()).toBe(201);
  expect(create.headers()["location"]).toMatch(/^https:\/\//);
});

test("an upload without files:write is rejected even with a valid token", async ({ request }) => {
  const token = await mintToken(request, `user:e2e-${randomUUID()}`, "");
  const res = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": "5",
      "upload-metadata": `filename ${b64("x.txt")}`,
    },
  });
  expect(res.status(), "a real, valid token still needs the role").toBe(403);
});

test("the three-action path in a real browser: drop a file, get a link", async ({ page, request }) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `browser-${randomUUID().slice(0, 8)}.txt`;
  const body = `dropped through the real drop zone ${randomUUID()}`;

  // Only the auth SDK is stubbed - it needs a live auth.mosni.dev to load at all. The token it hands back
  // is REAL and the server verifies it for real; tus-js-client, the upload and the delivery are all
  // genuine. Blocking sdk.js stops the real one merging over the stub (its last act is Object.assign).
  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(`
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => ({ sub: ${JSON.stringify(sub)}, roles: ["files:write"] }),
      token: () => ${JSON.stringify(token)},
      onChange: (cb) => cb({ sub: ${JSON.stringify(sub)}, roles: ["files:write"] }),
      login: () => {}, logout: () => {},
      toast: (m) => { window.__toast = m; },
    });
  `);

  await page.goto(`${FILES_ORIGIN}/`);

  // Drop the file the way the UI actually takes it - through the picker input the drop zone owns.
  // Scoped to the PRIMARY file picker: E6 added a second, folder-only input to the same panel, and it is
  // `multiple` too, so only the absence of `webkitdirectory` distinguishes them.
  await page.locator('[role="button"] input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(body),
  });

  // D-122 (E4.1 live-testing findings, Wave E): completion is a floating bottom-right stack element, one
  // per file - a "view" link (to the preview page) and a copy-direct-link icon button, not a compact
  // PreviewCard/CopyLink pair. It only appears once the upload really completed and the server returned
  // its URLs.
  const stackItem = page.locator(".panel", { hasText: filename });
  const viewLink = stackItem.locator("a", { hasText: "view" });
  await expect(viewLink).toBeVisible({ timeout: 30_000 });

  const shareUrl = await viewLink.getAttribute("href");
  expect(shareUrl).toContain(filename);

  // And the link it just handed the user actually resolves.
  const preview = await request.get(`${FILES_ORIGIN}${new URL(shareUrl!).pathname}`, {
    headers: { host: FILES_HOST },
  });
  expect(preview.status(), "the copied link must work").toBe(200);
  expect(await preview.text()).toContain(filename);
});

// E6 Wave I2 (D-172/D-173): closing the tab mid-upload and reopening it must resume from the server's
// offset, not silently re-upload from zero - which is exactly what disabling
// `resumeFromPreviousUpload()` in web/src/lib/uploads.ts would produce (both leave the stack showing a
// completed upload with the right name), so the only thing that actually distinguishes them is the
// server's received byte count. This test was run against a build with that call commented out before
// being written against the real one, and failed exactly as expected (fresh upload, not a continuation) -
// see the hand-off's §0.3 warning this exists to make visible.
test("resumption: closing the tab mid-upload and reopening it shows Paused, and re-offering the file finishes it byte-for-byte (D-172/D-173)", async ({
  page,
  request,
}) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `resume-${randomUUID().slice(0, 8)}.bin`;
  // Large enough to span several 5 MB chunks, so a reload partway through genuinely leaves a partial
  // upload on the server rather than racing its own completion.
  const size = 22 * 1024 * 1024;
  const body = Buffer.alloc(size);
  for (let i = 0; i < body.length; i++) body[i] = i % 256;
  // ⚠ A REAL file on disk, offered by PATH both times - not an inline Buffer (E6 review, session 042).
  // tus's browser fingerprint includes `file.lastModified`, and Playwright synthesises a fresh
  // lastModified for every Buffer-backed setFiles() call, so the second offer would look like a DIFFERENT
  // file, matchPausedJob() would refuse it, and this test could never pass - which is exactly what it did
  // before this change. A path-backed offer carries the file's real mtime, identical on both offers, so
  // the resume path is genuinely exercised rather than skipped.
  const fixturePath = path.join(tmpdir(), filename);
  await writeFile(fixturePath, body);

  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(`
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => ({ sub: ${JSON.stringify(sub)}, roles: ["files:write"] }),
      token: () => ${JSON.stringify(token)},
      onChange: (cb) => cb({ sub: ${JSON.stringify(sub)}, roles: ["files:write"] }),
      login: () => {}, logout: () => {},
      toast: (m) => { window.__toast = m; },
    });
  `);

  await page.goto(`${FILES_ORIGIN}/`);

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[role="button"]').first().click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(fixturePath);

  // Wait for real upload progress (at least one full chunk PATCHed) before reloading, so there is
  // something on the server to resume FROM - not just a create with nothing uploaded yet.
  await expect(page.locator(".progress-label", { hasText: "%" }).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);

  await page.reload();

  // B4/B8: the reload's restorePausedUploads() call HEADs the stored URL and republishes the job as
  // Paused with the server's real offset - this is the tab-closed-and-reopened case (D-172), distinct
  // from the still-open-tab retry case (D-173) the previous test's network layer covers indirectly via
  // tus's own retry loop.
  const pausedItem = page.locator(".panel", { hasText: filename });
  await expect(pausedItem).toBeVisible({ timeout: 15_000 });
  await expect(pausedItem).toContainText("Paused");
  await expect(pausedItem).not.toContainText("Retry");

  const resumeFileChooser = page.waitForEvent("filechooser");
  await pausedItem.getByRole("button", { name: /^Resume/ }).click();
  const resumeChooser = await resumeFileChooser;
  // Re-offering the SAME file - same name, size AND lastModified, which is what matchPausedJob() needs
  // to accept it as a continuation rather than a new upload (see the fixture note above).
  await resumeChooser.setFiles(fixturePath);

  const viewLink = pausedItem.locator("a", { hasText: "view" });
  await expect(viewLink).toBeVisible({ timeout: 30_000 });
  const shareUrl = await viewLink.getAttribute("href");

  // The decisive assertion: the server holds the WHOLE file, not just the bytes that arrived before the
  // reload plus a truncated remainder, and not the file re-sent from zero on top of what it already had.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  let diskRelPath: string;
  try {
    const [rows] = await conn.execute("SELECT disk_dir, disk_name FROM files WHERE name = ?", [filename]);
    const row = (rows as { disk_dir: string; disk_name: string }[])[0];
    expect(row, "the resumed file's row must exist").toBeTruthy();
    diskRelPath = `${row!.disk_dir}/${row!.disk_name}`;
  } finally {
    await conn.end();
  }
  const onDisk = await readFile(path.join(STORAGE_ROOT, diskRelPath));
  expect(onDisk.length).toBe(body.length);
  expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
    createHash("sha256").update(body).digest("hex"),
  );
  void shareUrl;
});

// E6 Wave I3's folder-ingest test lived here and was DELETED on 2026-08-06, when Hannah removed the
// "or choose a folder" picker: the picker was the only folder entry point Playwright can drive. A real
// folder DRAG populates FileSystemDirectoryEntry objects at the OS/browser level that JS-dispatched drag
// events cannot fake, so folder ingest now has no end-to-end coverage at all - only unit coverage
// (web/test/unit/folderWalk.test.ts for the walk and its guards, collections.test.ts for
// ensureCollectionPath, DropZone.test.tsx for the component wiring a dropped directory into them). A real
// folder drop is therefore a MANUAL check on the box - see agent-docs `issues.md` -> E6-FOLDER-E2E-GAP.
