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
// straight into the shared volume with rows inserted directly, rather than driven through a real upload.

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

// textPreview matters: seeding rows directly means probeMedia() never runs, so leaving it null sends the
// .txt preview down its iframe fallback instead of the <mosni-code> path - i.e. the check would silently
// screenshot the wrong branch. Seed what a real ingest would have captured (D-74).
async function seed(
  conn,
  { relPath, protection = "public", bytes, width = null, height = null, textPreview = null },
) {
  const abs = path.join(STORAGE_ROOT, ...relPath.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    "INSERT INTO files (path, bytes, protection, link_token, width, height, text_preview) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [relPath, bytes.length, protection, linkToken, width, height, textPreview],
  );
  return { relPath, linkToken };
}

const run = randomUUID().slice(0, 8);

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? "mariadb",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "files",
  password: process.env.DB_PASS ?? "filespass",
  database: process.env.DB_NAME ?? "files",
});

// Every page state session 010 touched, plus the ones D-70 introduced.
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

const WRITER = { sub: "user:visual-check", name: "Hannah", roles: ["files:write"] };
const NO_ROLE = { sub: "user:visual-check", name: "Hannah", roles: [] };

const PAGES = [
  { id: "landing", label: "Landing - signed out", url: "/", note: "The whole page when signed out (F5)" },
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
