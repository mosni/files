#!/usr/bin/env node
// Review-session visual check (HANDOFF.md's review-session rule): drives a real browser over every page
// state a review touched, at BOTH a desktop and a mobile viewport, and saves screenshots for the lead's
// manual sign-off. Complements scripts/screenshot.mjs, which grabs ONE ad-hoc page; this one walks a
// defined set of states so a review cannot quietly skip one.
//
// Runs INSIDE the verify-e2e container (it needs the compose network to resolve `files-e2e.test`, the
// e2e-storage volume to seed fixture bytes, and mariadb to insert the matching rows):
//
//   docker compose -f docker-compose.verify.yml run --rm -T \
//     -v "<host-out-dir>:/out" verify-e2e node scripts/visual-check.mjs /out
//
// Seeding mirrors e2e/preview.spec.ts exactly: there is no live IdP here, so fixtures are written
// straight into the shared volume with rows inserted directly (via the E3 schema - collections + files
// with surrogate ids, D-81), rather than driven through a real upload.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";
import mysql from "mysql2/promise";

const STORAGE_ROOT = "/data/storage";
// Must be the host-constrained alias, not the container name - see docker-compose.verify.yml's long note
// on why app-e2e answers on port 80 under `files-e2e.test`.
const ORIGIN = "http://files-e2e.test";
const OUT_DIR = process.argv[2] ?? "/out";

const VIEWPORTS = [
  { name: "desktop", options: { viewport: { width: 1280, height: 800 } } },
  { name: "mobile", options: devices["iPhone 13"] },
];

// A minimal valid PNG (1x1 red), so an <img> preview has real decodable bytes rather than a broken icon.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function newId() {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

// textPreview matters: seeding rows directly means probeMedia() never runs, so leaving it null sends the
// .txt preview down its iframe fallback instead of the <mosni-code> path - i.e. the check would silently
// screenshot the wrong branch. Seed what a real ingest would have captured (D-74).
//
// D-81: `relPath` keeps its old one-segment-plus-filename shape for every caller below, but is now split
// into a fresh root-level collection plus a file addressed by a surrogate id - the disk bytes live at
// `<YYYY>/<mm>/<id>-<name>`, an internal detail the URL never mirrors.
// Collections are keyed (parent_id, name) UNIQUE, and every fixture below shares one `vis-<run>/` prefix -
// so the collection has to be created once and reused. Creating a fresh one per fixture (as the first
// E3 version of this script did) fails on the SECOND seed with ER_DUP_ENTRY, which made the script
// unrunnable end to end; it was written in session 015 but never executed there, so nothing caught it.
const collectionIdsByName = new Map();

async function collectionFor(conn, name, ownerSub) {
  const existing = collectionIdsByName.get(name);
  if (existing !== undefined) return existing;
  const id = newId();
  // D-98: `link_token` defaults to '' and is uniquely indexed - every collection created by a repeat run
  // of this script needs its own real token, or the second run's insert collides on the column's shared
  // default (the same bug e2e/preview.spec.ts's seed() fixed).
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection, link_token) VALUES (?, '', ?, ?, 'unlisted', ?)",
    [id, name, ownerSub, linkToken],
  );
  collectionIdsByName.set(name, id);
  return id;
}

async function seed(
  conn,
  { relPath, protection = "public", bytes, width = null, height = null, textPreview = null, ownerSub = null },
) {
  const segments = relPath.split("/");
  const name = segments[segments.length - 1];
  const collectionName = segments.slice(0, -1).join("/");
  const collectionId = await collectionFor(conn, collectionName, ownerSub ?? "user:visual-check-fixtures");
  const fileId = newId();
  const diskDir = "2026/07";
  const diskName = `${fileId}-${name}`;

  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);

  await conn.execute(
    `INSERT INTO files
      (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub, width, height, text_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?)`,
    [fileId, collectionId, name, diskDir, diskName, bytes.length, protection, linkToken, ownerSub, width, height, textPreview],
  );
  return { relPath, linkToken, fileId };
}

const run = randomUUID().slice(0, 8);

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? "mariadb",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "files",
  password: process.env.DB_PASS ?? "filespass",
  database: process.env.DB_NAME ?? "files",
});

const WRITER = { sub: "user:visual-check", name: "Hannah", roles: ["files:write"] };
const NO_ROLE = { sub: "user:visual-check", name: "Hannah", roles: [] };

// Every page state session 010 touched, plus the ones D-70 and E3 introduced.
const image = await seed(conn, {
  relPath: `vis-${run}/holiday-photo.png`,
  bytes: PNG_1PX,
  width: 1200,
  height: 800,
});
const video = await seed(conn, { relPath: `vis-${run}/clip.mp4`, bytes: Buffer.from("fake mp4 bytes") });
const pdf = await seed(conn, { relPath: `vis-${run}/invoice.pdf`, bytes: Buffer.from("%PDF-1.4 fake") });
const TXT_BODY = [
  "# deploy notes",
  "",
  "1. bump the container port in docker-compose.yml and nginx.conf",
  "2. mkdir -p /srv/stack/data/files/storage on the box",
  "3. confirm the cert issues on first deploy",
].join("\n");
const txt = await seed(conn, {
  relPath: `vis-${run}/notes.txt`,
  bytes: Buffer.from(TXT_BODY),
  textPreview: TXT_BODY,
});
const zip = await seed(conn, { relPath: `vis-${run}/archive.zip`, bytes: Buffer.from("PK fake zip") });
const priv = await seed(conn, { relPath: `vis-${run}/confidential.txt`, bytes: Buffer.from("secret"), protection: "private" });
const secret = await seed(conn, { relPath: `vis-${run}/hidden.txt`, bytes: Buffer.from("hidden"), protection: "secret" });
// E3/D-89: owned by WRITER, so an authenticated request from WRITER's own token shows the manage controls.
const owned = await seed(conn, {
  relPath: `vis-${run}/my-report.pdf`,
  bytes: Buffer.from("%PDF-1.4 fake"),
  protection: "unlisted",
  ownerSub: WRITER.sub,
});

// E4 session 020 (Waves D-F): the browser's own fixtures. `collectionFor`/`seed` above assume one flat
// `vis-<run>/` collection and can't express a collection's OWN protection (D-95) or nesting beyond one
// level, so these are raw inserts rather than reusing them.
async function seedBrowserCollection({ parentId = "", name, ownerSub, protection = "unlisted" }) {
  const id = newId();
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    "INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, parentId, name, ownerSub, protection, protection, linkToken],
  );
  return id;
}

async function seedBrowserFile(collectionId, name, ownerSub, protection = "public") {
  const fileId = newId();
  const diskDir = "2026/07";
  const diskName = `${fileId}-${name}`;
  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "browser fixture bytes");
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    `INSERT INTO files (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
    [fileId, collectionId, name, diskDir, diskName, 21, protection, linkToken, ownerSub],
  );
  return fileId;
}

// D-94: a small public tree, so an anonymous visitor's Browse tab has something to show. `browserNested`
// is what the breadcrumb drill-down state navigates into.
const browserRoot = await seedBrowserCollection({ name: `vis-${run}-public`, ownerSub: WRITER.sub, protection: "public" });
await seedBrowserFile(browserRoot, "welcome.txt", WRITER.sub, "public");
const browserNested = await seedBrowserCollection({ parentId: browserRoot, name: "nested", ownerSub: WRITER.sub, protection: "public" });
await seedBrowserFile(browserNested, "deep-file.txt", WRITER.sub, "public");
// A stranger's row inside the same public collection, so the admin all-files state shows a non-owner row.
await seedBrowserFile(browserRoot, "someone-elses-file.txt", "user:visual-check-stranger", "unlisted");
// WRITER's own collection with a nested child + files, for the recursive-delete confirmation state (D-104).
const deletableTop = await seedBrowserCollection({ name: `vis-${run}-deletable`, ownerSub: WRITER.sub });
const deletableChild = await seedBrowserCollection({ parentId: deletableTop, name: "child", ownerSub: WRITER.sub });
await seedBrowserFile(deletableTop, "top-file.txt", WRITER.sub, "unlisted");
await seedBrowserFile(deletableChild, "child-file.txt", WRITER.sub, "unlisted");

await conn.end();

// Stubs the auth SDK before any page script runs, so the SIGNED-IN drop zone can be rendered without a
// live auth.mosni.dev. This exists because session 010 shipped a "visual check" that only ever saw the
// signed-out state - i.e. it never once looked at the upload UI, which is the entire product (D-1).
// It does NOT make uploads work (the server still rejects an unverifiable bearer); it renders the UI.
const signedInAs = (claims) => `
  window.mosni = Object.assign(window.mosni ?? {}, {
    user: () => (${JSON.stringify(claims)}),
    token: () => "visual-check-not-a-real-token",
    onChange: (cb) => cb(${JSON.stringify(claims)}),
    login: () => {}, logout: () => {},
    toast: (m) => { window.__lastToast = m; },
  });
`;

// E4 session 020: an EXPLICIT signed-out stub, for states that must represent "no user" rather than just
// omitting `init`. DropZone and FileBrowser both poll for `window.mosni` before deciding what to render
// (anonymous or not) and never give up - production always gets there once auth.mosni.dev answers, but in
// a sandbox where that domain (and ui.mosni.dev) fail TLS validation, `window.mosni` never appears without
// SOME stub, and the page sits on its loading spinner forever. Discovered because "landing" (this repo's
// oldest page state, session 010) has silently screenshotted a blank page every run since - nobody had
// looked closely enough to notice a stuck spinner isn't a "signed out" view. Giving it this stub, rather
// than leaving it broken, is what verification-concept.md's own rule asks for ("the finding is 'not ready'
// - never a nicer presentation of it. Fix it.").
const signedOut = `
  window.mosni = Object.assign(window.mosni ?? {}, {
    user: () => null,
    token: () => null,
    onChange: (cb) => cb(null),
    login: () => {}, logout: () => {},
    toast: () => {},
  });
`;

// A real, verify()-acceptable token, for states that need a genuinely authorized request rather than a
// seeded row: the compact preview card (finding 6), and E3's owner manage controls (D-89), which only
// render once the client's own /api/preview fetch (carrying this Bearer) confirms isOwner. Same issuer
// the e2e tier uses (mock-idp), reachable from this container the same way (docker-compose.verify.yml).
async function mintToken(sub, roles = "files:write") {
  const idp = process.env.MOCK_IDP ?? "http://mock-idp:9000";
  const res = await fetch(`${idp}/token?sub=${encodeURIComponent(sub)}&roles=${encodeURIComponent(roles)}`);
  if (!res.ok) throw new Error(`mock-idp mint failed: ${res.status}`);
  return (await res.json()).token;
}

const signedInAsReal = (claims, token) => `
  window.mosni = Object.assign(window.mosni ?? {}, {
    user: () => (${JSON.stringify(claims)}),
    token: () => ${JSON.stringify(token)},
    onChange: (cb) => cb(${JSON.stringify(claims)}),
    login: () => {}, logout: () => {},
    toast: (m) => { window.__lastToast = m; },
  });
`;

const uploadToken = await mintToken(WRITER.sub);
// D-101: the admin/all-files gate needs BOTH roles - see lib/roles.ts's isFilesAdmin().
const adminToken = await mintToken("user:visual-check-admin", "files:write,files:delete");
const ADMIN = { sub: "user:visual-check-admin", name: "Admin", roles: ["files:write", "files:delete"] };

const PAGES = [
  { id: "landing", label: "Landing - signed out", url: "/", note: "The whole page when signed out (F5)", init: signedOut },
  {
    id: "landing-dropzone",
    label: "Landing - signed in, the drop zone",
    url: "/",
    note: "THE product surface (D-1). Never visually checked before this run.",
    init: signedInAs(WRITER),
  },
  {
    id: "landing-no-access",
    label: "Landing - signed in without files:write",
    url: "/",
    note: "F5's third gating branch",
    init: signedInAs(NO_ROLE),
  },
  { id: "preview-image", label: "Preview - image", url: `/f/${image.relPath}`, note: "<title> fix: must show the filename, not the bare site name" },
  { id: "preview-video", label: "Preview - video", url: `/f/${video.relPath}`, note: "Plain <video controls> - not Vidstack (E5)" },
  { id: "preview-pdf", label: "Preview - PDF", url: `/f/${pdf.relPath}`, note: "iframe to dl. - the frame-src/frame-ancestors fix (D-77)" },
  { id: "preview-text", label: "Preview - text", url: `/f/${txt.relPath}`, note: "iframe to dl." },
  { id: "preview-download-card", label: "Preview - download card", url: `/f/${zip.relPath}`, note: "Non-inline type falls back to the download card" },
  { id: "preview-secret-token", label: "Preview - secret via /t/<token>", url: `/t/${secret.linkToken}`, note: "The only way to reach a secret file (D-59)" },
  { id: "preview-private-anon", label: "Preview - private, signed out", url: `/f/${priv.relPath}`, note: "Must reveal nothing: shared not-found panel (D-72/D-75)" },
  { id: "notfound-secret-path", label: "404 - secret at its readable path", url: `/f/${secret.relPath}`, note: "Must 404, never 403 (D-59, never-delete)" },
  { id: "notfound-missing", label: "404 - nonexistent path", url: `/f/vis-${run}/does-not-exist.png`, note: "Styled NotFound view (P1)" },
  {
    id: "landing-completed-upload",
    label: "Landing - signed in, upload just completed (compact preview card)",
    url: "/",
    note: "E2-UPLOAD-FIXES finding 6: the compact PreviewCard replaces bare links on completion. A real " +
      "upload through mock-idp, not a seeded row. The image's dl.mosni.dev subresource is expected to fail " +
      "in this sandbox (no live dl. origin) - that is a sandbox artifact, not a defect; layout, the " +
      "progress-free completed state and the copy control are what this validates.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.locator('input[type="file"]').setInputFiles({
        name: `vis-${run}-drop.png`,
        mimeType: "image/png",
        buffer: PNG_1PX,
      });
      await p.locator(".copy-field-primary input").first().waitFor({ state: "visible", timeout: 30_000 });
      // The share field appears as soon as the upload completes; the compact card is a second, best-effort
      // fetch to /api/preview on top of that - give it a moment to land before the screenshot.
      await p.waitForTimeout(1000);
    },
  },
  {
    id: "landing-drag-over",
    label: "Landing - signed in, dragging a file over the page (drag-over affordance)",
    url: "/",
    note: "E2-UPLOAD-FIXES finding 2: page-level + zone-level drag-over affordance. Neither may intercept " +
      "the actual drop (the overlay is pointer-events:none).",
    init: signedInAs(WRITER),
    interact: async (p) => {
      await p.waitForSelector('[role="button"]');
      await p.evaluate(() => {
        function fireDrag(target, type) {
          const event = new DragEvent(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [] } });
          target.dispatchEvent(event);
        }
        fireDrag(window, "dragenter");
        const zone = document.querySelector('[role="button"]');
        fireDrag(zone, "dragenter");
        fireDrag(zone, "dragover");
      });
      await p.waitForTimeout(100);
    },
  },
  {
    id: "landing-destination-picker",
    label: "Landing - signed in, the Options disclosure expanded (destination picker)",
    url: "/",
    note: "G1/G2 (D-42/D-86): collapsed by default; this state opens it to show the collection select " +
      "and the new-collection field. Must never be the DEFAULT state (D-1's fast path stays three actions).",
    init: signedInAs(WRITER),
    interact: async (p) => {
      await p.locator("details summary").click();
      await p.waitForTimeout(150);
    },
  },
  {
    id: "preview-owner-controls",
    label: "Preview - owner, the manage controls (rename / protection / delete)",
    url: `/f/${owned.relPath}`,
    note: "D-89: rename form, protection selector and the Delete button, all owner-only. Requires the " +
      "background /api/preview refetch (with a real Bearer) to confirm isOwner - the embedded document " +
      "copy is always isOwner:false (D-75), so this state only appears after that round trip settles.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector("text=Delete file", { timeout: 10_000 }).catch(() => {});
    },
  },
  {
    id: "preview-delete-confirm",
    label: "Preview - owner, the delete confirmation step",
    url: `/f/${owned.relPath}`,
    note: "D-89: clicking Delete must show a confirm/cancel step, never delete on the first click. This " +
      "run only opens the confirmation - it never clicks \"Yes, delete\", so the fixture survives for the " +
      "next state/run.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector("text=Delete file", { timeout: 10_000 }).catch(() => {});
      await p.locator("button", { hasText: "Delete file" }).click();
      await p.waitForTimeout(150);
    },
  },
  {
    id: "browser-public-signed-out",
    label: "Landing - browser section, signed out (public tree, D-94)",
    url: "/",
    note: "E4 Wave D: the anonymous Browse tree, below the drop zone (D-1/D-93). An explicit signed-out " +
      "stub (see signedOut above) - an anonymous visitor's browse must never depend on the real auth SDK " +
      "resolving, which this sandbox can't do anyway.",
    init: signedOut,
    interact: async (p) => {
      await p.waitForSelector("text=welcome.txt", { timeout: 10_000 }).catch(() => {});
    },
  },
  {
    id: "browser-mine-signed-in",
    label: "Landing - browser section, signed in (My files)",
    url: "/",
    note: "E4 Wave D: the default tab for a signed-in user - their own collections and files below the " +
      "drop zone. A real Bearer, so the /api/browse fetch actually authorizes.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector("mosni-tabs", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(500);
    },
  },
  {
    id: "browser-nested-breadcrumb",
    label: "Landing - browser section, drilled into a nested collection (breadcrumb)",
    url: "/",
    note: "E4 Wave D: clicking into the public tree's nested collection and back out via the breadcrumb " +
      "(D-102). Signed out - the public tree is what has the nesting fixture.",
    init: signedOut,
    interact: async (p) => {
      // "nested" is a CHILD of the public root collection - drill into that first, or "nested" is never
      // on screen to click and this hangs on Playwright's default 30s actionability timeout.
      await p.waitForSelector(`text=vis-${run}-public`, { timeout: 10_000 }).catch(() => {});
      await p.locator("button", { hasText: `vis-${run}-public` }).first().click();
      await p.waitForSelector("text=nested", { timeout: 10_000 }).catch(() => {});
      await p.locator("button", { hasText: "nested" }).first().click();
      await p.waitForSelector("text=deep-file.txt", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(200);
    },
  },
  {
    id: "browser-admin-all",
    label: "Landing - browser section, admin All files view",
    url: "/",
    note: "D-101: reachable only by a caller holding both files:write and files:delete. Shows a stranger's " +
      "row with the 'admin' visibility badge (D-103) alongside the admin's own ('own' takes precedence).",
    init: signedInAsReal(ADMIN, adminToken),
    interact: async (p) => {
      await p.waitForSelector("mosni-tabs", { timeout: 10_000 }).catch(() => {});
      // mosni-tabs only turns its <mosni-tab> children into a real clickable bar once mosnicat.js
      // (ui.mosni.dev) upgrades the element - unreachable from this sandbox (same TLS-trust gap as
      // auth.mosni.dev), so there is nothing here to click in THIS environment specifically. The tab-
      // switching LOGIC itself (mosni-tab-change -> scope change) is exercised directly, without needing
      // the chrome's real DOM, by FileBrowser.test.tsx - a short timeout here rather than the default 30s
      // keeps a sandbox-only gap from stalling the whole run.
      await p.locator("mosni-tabs button", { hasText: "All files" }).click({ timeout: 3_000 }).catch(() => {});
      // The stranger's file is a CHILD of the public root collection - files never show at the pseudo-root.
      // Best-effort past this point too: without a real tab click above, this sandbox is still on the
      // admin's own "My files" default and neither locator will ever appear - that is a known, sandbox-
      // only gap (see the comment above), not a product defect, and must not fail the whole run.
      await p.waitForSelector(`text=vis-${run}-public`, { timeout: 10_000 }).catch(() => {});
      await p.locator("button", { hasText: `vis-${run}-public` }).first().click({ timeout: 3_000 }).catch(() => {});
      await p.waitForSelector("text=someone-elses-file.txt", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(200);
    },
  },
  {
    id: "browser-collection-delete-confirm",
    label: "Landing - browser section, the recursive collection-delete confirmation",
    url: "/",
    note: "D-104/D-88: recursive collection delete gets its own confirmation naming the descendant count - " +
      "the most destructive operation in the app. This run only opens the confirmation (a dryRun fetch), " +
      "it never clicks \"Yes, delete\", so the fixture survives for the next run.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector(`text=vis-${run}-deletable`, { timeout: 10_000 }).catch(() => {});
      const row = p.locator("[data-row-id]", { hasText: `vis-${run}-deletable` });
      await row.locator("button", { hasText: "Delete" }).click();
      await p.waitForSelector("text=This can't be undone.", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(150);
    },
  },
];

const browser = await chromium.launch();
const results = [];
const overflowFailures = [];

try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext(vp.options);
    for (const page of PAGES) {
      const p = await context.newPage();
      if (page.init) {
        // The real auth SDK IS reachable from this container, and its last act is
        // `Object.assign(window.mosni ?? {}, mosni)` - which merges the live (signed-out) methods over
        // the stub and silently defeats it. Blocking the script is what makes the stub authoritative.
        await p.route("**/sdk.js", (route) => route.abort());
        await p.addInitScript(page.init);
      }
      const target = `${ORIGIN}${page.url}`;
      let title = "(navigation failed)";
      let status = null;
      let overflow = null;
      try {
        const res = await p.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
        status = res?.status() ?? null;
        // The SPA paints from the embedded context on the first frame; a private/missing file has none
        // and must round-trip to the API first, so give the client state machine a moment to settle.
        await p.waitForTimeout(700);
        if (page.interact) await page.interact(p);
        title = await p.title();
        // A page that scrolls sideways is broken, and it is easy to miss in a screenshot because the
        // capture silently widens to fit. Measure it instead of trusting the eye - the first pass of
        // session 010's layout fix shipped 1533px of content into a 1280px viewport and looked fine.
        overflow = await p.evaluate(() => {
          const doc = document.documentElement;
          return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
        });
      } catch (err) {
        title = `(error: ${err.message.split("\n")[0]})`;
      }
      const file = `${page.id}-${vp.name}.png`;
      await p.screenshot({ path: path.join(OUT_DIR, file), fullPage: true });
      const overflows = overflow !== null && overflow.scrollWidth > overflow.clientWidth + 1;
      if (overflows) overflowFailures.push(`${page.id} @ ${vp.name} (${overflow.scrollWidth}px in ${overflow.clientWidth}px)`);
      results.push({ ...page, viewport: vp.name, file, title, status, overflow, overflows });
      console.log(
        `${vp.name.padEnd(7)} ${String(status ?? "---").padEnd(4)} ${page.url}  ->  ${file}` +
          `  [title: ${title}]${overflows ? "  ** HORIZONTAL OVERFLOW **" : ""}`,
      );
      await p.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nWrote ${results.length} screenshots + results.json to ${OUT_DIR}`);

if (overflowFailures.length > 0) {
  console.error(`\nHORIZONTAL OVERFLOW on ${overflowFailures.length} page state(s):`);
  for (const f of overflowFailures) console.error(`  - ${f}`);
  process.exitCode = 1;
}
