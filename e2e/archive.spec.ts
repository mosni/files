import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ensureSharedDir } from "./seedStorage.ts";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";
import { ZipReader, BlobReader } from "@zip.js/zip.js";

// E5.1 Wave H (H1/H2, D-162): the archive (E5 Wave G/D-133) is a service worker StreamSaver, and service
// workers require a secure context - the e2e tier ran on plain HTTP before this wave, so
// `navigator.serviceWorker` was `undefined`, `isArchiveSupported()` was false, and "Download all" never
// even rendered. That is why the archive shipped completely non-functional (session 033) and was only
// caught by a human on a phone (D-149/D-150, review session 034) - nothing automated COULD have caught it.
// nginx-e2e now terminates real TLS, closing that gap. Same fixture/seeding pattern as e2e/browse.spec.ts.

const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `https://${FILES_HOST}`;
const STORAGE_ROOT = "/data/storage";

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string) {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=files:write`);
  expect(res.ok(), "mock-idp must mint a token").toBeTruthy();
  return (await res.json()).token as string;
}

async function withDb<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

async function seedCollection(
  conn: mysql.Connection,
  opts: { name: string; ownerSub: string; parentId?: string; protection?: "unlisted" | "secret" },
): Promise<{ id: string; linkToken: string }> {
  const id = newId();
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  const protection = opts.protection ?? "unlisted";
  await conn.execute(
    "INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, opts.parentId ?? "", opts.name, opts.ownerSub, protection, protection, linkToken],
  );
  return { id, linkToken };
}

async function seedFile(
  conn: mysql.Connection,
  opts: { collectionId: string; name: string; ownerSub: string; body: string },
): Promise<{ id: string }> {
  const id = newId();
  const diskDir = "2026/08";
  const diskName = `${id}-${opts.name}`;
  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  // Review 060/SEC-2: shared-writable - app-e2e writes this same directory. See e2e/seedStorage.ts.
  await ensureSharedDir(path.dirname(abs));
  await writeFile(abs, opts.body);
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    `INSERT INTO files (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub)
     VALUES (?, ?, ?, ?, ?, ?, 'unlisted', ?, 'committed', ?)`,
    [id, opts.collectionId, opts.name, diskDir, diskName, Buffer.byteLength(opts.body), linkToken, opts.ownerSub],
  );
  return { id };
}

test("the archive service worker registers and controls the page (AC-H1/H2)", async ({ page }) => {
  const sub = `user:e2e-archive-${randomUUID()}`;
  const token = await mintToken(page.request, sub);

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

  await page.goto(`${FILES_ORIGIN}/`);

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15_000 });
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return reg !== undefined && reg.active !== null;
  });
  expect(registered).toBe(true);
});

test("\"Download all\" produces a real zip, preserving a nested subtree path (AC-F1/F2, AC-H2/H3)", async ({
  page,
}) => {
  const run = randomUUID().slice(0, 8);
  const sub = `user:e2e-archive-${run}`;
  const token = await mintToken(page.request, sub);

  const root = await withDb((conn) => seedCollection(conn, { name: `arc-${run}`, ownerSub: sub }));
  await withDb((conn) => seedFile(conn, { collectionId: root.id, name: "root.txt", ownerSub: sub, body: "root file contents" }));
  const sub_ = await withDb((conn) => seedCollection(conn, { name: "Nested", ownerSub: sub, parentId: root.id }));
  await withDb((conn) => seedFile(conn, { collectionId: sub_.id, name: "nested.txt", ownerSub: sub, body: "nested file contents" }));

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

  await page.goto(`${FILES_ORIGIN}/`);
  await page.getByRole("link", { name: `arc-${run}` }).click();
  await page.waitForURL(/\/f\//);

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15_000 });

  const downloadButton = page.getByRole("button", { name: "Download all" });
  await expect(downloadButton).toBeVisible({ timeout: 10_000 });

  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), downloadButton.click()]);

  // ⚠ SANDBOX-ONLY LIMITATION, found by executing this wave (not a defect - see the header comment and
  // technical-baseline.md's E5.1 Wave H entry): nginx's Access-Control-Allow-Origin is hardcoded to the
  // REAL "https://files.mosni.dev" (a mandatory never-delete assertion this tier deliberately never
  // rewrites), and THIS tier's own origin is "https://files-e2e.test" - so the service worker's per-file
  // fetch()es to dl.mosni.dev are CORS-blocked here specifically, and every file lands in the job's
  // `failed[]` tail rather than the zip. On the real box, files.mosni.dev IS the real origin and this
  // mismatch does not exist. What THIS test can and does prove in this tier: the walk discovers BOTH
  // files across the nested subtree (AC-F1) and the archive completes (downloads, doesn't hang) rather
  // than proving byte-for-byte zip contents, which needs the real box.
  const zipPath = await download.path();
  expect(zipPath, "the archive must actually save to disk, not hang (even when every entry is CORS-failed in this tier)").toBeTruthy();

  // A well-formed zip stream even with zero successful entries - this is exactly the class of bug
  // D-149/D-150 fixed (an unterminated zip stream hangs the download forever rather than completing
  // short). Opening it without throwing proves zipStream.close() ran.
  const zipBlob = new Blob([await readFile(zipPath!)]);
  const reader = new ZipReader(new BlobReader(zipBlob));
  await expect(reader.getEntries()).resolves.toBeDefined();
  await reader.close();

  const stack = page.locator(".job-stack");
  await expect(stack).toContainText("2 files could not be included", { timeout: 15_000 });
});

// E5/E5.1 review session (039). The walk used to pass NO token below its own root, so for the one viewer
// class that reaches a collection purely by its link - an anonymous holder of a `secret` collection's
// /t/<token> URL, which is the whole point of that protection level - every nested collection's browse
// call 404d and its files silently vanished from the zip, with nothing in the "could not be included"
// tail to say so. Anonymous by construction: this is invisible to any signed-in check, exactly the class
// of gap H6 was added for.
test("an anonymous /t/<token> viewer's archive still reaches a NESTED collection (AC-F1, review 039)", async ({
  page,
}) => {
  const run = randomUUID().slice(0, 8);
  const owner = `user:e2e-secret-${run}`;

  const root = await withDb((conn) =>
    seedCollection(conn, { name: `sec-${run}`, ownerSub: owner, protection: "secret" }),
  );
  // `unlisted`, not `secret`: a stored-`secret` row is deliberately absent from every listing including a
  // link-authorized one (D-59 - it is reachable ONLY by its own token), so it could never be walked and is
  // not the case here. An `unlisted` child of a `secret` parent IS listed, its EFFECTIVE protection is
  // `secret` (the chain, D-96), and the parent's response hands the viewer that child's own /t/<token>
  // previewUrl - which is exactly how the UI navigates into it, and what the walk must use too.
  const child = await withDb((conn) =>
    seedCollection(conn, { name: "Nested", ownerSub: owner, parentId: root.id, protection: "unlisted" }),
  );
  await withDb((conn) => seedFile(conn, { collectionId: child.id, name: "deep.txt", ownerSub: owner, body: "deep" }));

  // A genuine anonymous visitor holding only the link - but with an EXPLICIT signed-out stub, the same one
  // scripts/visual-check.mjs uses. Blocking sdk.js without one leaves `window.mosni` undefined, and the
  // client's auth subscription then never settles, so the browser renders its loading spinner forever -
  // a harness artifact, not the product's signed-out behaviour (in production sdk.js always loads).
  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(`
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => null, token: () => null, onChange: (cb) => cb(null),
      login: () => {}, logout: () => {}, toast: () => {},
    });
  `);
  await page.goto(`${FILES_ORIGIN}/t/${root.linkToken}`);

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15_000 });

  const downloadButton = page.getByRole("button", { name: "Download all" });
  await expect(downloadButton).toBeVisible({ timeout: 10_000 });
  await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), downloadButton.click()]);

  // Same tier limitation as the test above: the per-file fetch is CORS-blocked here, so the file lands in
  // the failed[] tail. The COUNT is the point - it is 1 only if the walk got into the nested collection at
  // all. Before the fix this read "0 files" (nothing discovered below the root).
  await expect(page.locator(".job-stack")).toContainText("1 file could not be included", { timeout: 15_000 });
});
