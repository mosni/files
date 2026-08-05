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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import mysql from "mysql2/promise";

const STORAGE_ROOT = "/data/storage";
// Must be the host-constrained alias, not the container name - see docker-compose.verify.yml's long note
// on why app-e2e answers on port 80 under `files-e2e.test`.
// E5.1 Wave H (D-162): https, not http - nginx-e2e now terminates real TLS for this tier (a self-signed
// cert covering files-e2e.test AND dl.mosni.dev), which is also why the archive/video page states below
// finally show their real behaviour instead of a structurally-broken one.
const ORIGIN = "https://files-e2e.test";
const OUT_DIR = process.argv[2] ?? "/out";

// ignoreHTTPSErrors is LOAD-BEARING for this script, not a convenience (review session 022). The design
// system - `<mosni-header>`, `<mosni-tabs>`, `<mosni-code>`, `.panel`, `.badge`, `.btn`, and the ONLY
// stylesheet the app has - all arrive from https://ui.mosni.dev/mosnicat.js, and this sandbox's egress
// proxy is not trusted by Playwright's bundled Chromium, which uses its own certificate verifier and
// ignores the system and NSS stores alike (measured: `certutil -A` into /root/.pki/nssdb changes nothing).
// Without this flag mosnicat.js fails with ERR_CERT_AUTHORITY_INVALID, `customElements.get("mosni-tabs")`
// is undefined, `document.styleSheets.length` is 0, and EVERY page screenshots as unstyled black-on-white
// with no header, no panels and no badges - which is indistinguishable from a genuinely broken page and is
// exactly how sessions 017 and 020 signed off 78 screenshots that showed nothing of what D-79 exists to
// check ("layout, typography and chrome"). Same technique, same reason, as session 021's scoped
// `test.use({ ignoreHTTPSErrors: true })` in e2e/browse.spec.ts.
// E5.1 Wave H (D-162): nginx-e2e now DOES terminate real TLS for `ORIGIN` itself (a self-signed cert), so
// this flag now waves through TWO different untrusted certs for two different reasons - the sandbox
// proxy's (for ui.mosni.dev) and nginx-e2e's own self-signed one (for files-e2e.test/dl.mosni.dev). Both
// are test-only trust relaxations; neither exists in production, which terminates real, CA-issued certs.
const IGNORE_TLS = { ignoreHTTPSErrors: true };

const VIEWPORTS = [
  { name: "desktop", options: { ...IGNORE_TLS, viewport: { width: 1280, height: 800 } } },
  { name: "mobile", options: { ...devices["iPhone 13"], ...IGNORE_TLS } },
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
  {
    relPath,
    protection = "public",
    bytes,
    width = null,
    height = null,
    textPreview = null,
    ownerSub = null,
    // E5 Wave C / E5.1 Wave C (AC10, D-168): the uploader block. Null by default so every pre-existing
    // fixture keeps rendering exactly as it did (a pre-E5 file, never backfilled - D-138).
    uploaderSub = null,
    uploaderName = null,
  },
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
      (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub, width, height, text_preview, uploader_sub, uploader_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?)`,
    [fileId, collectionId, name, diskDir, diskName, bytes.length, protection, linkToken, ownerSub, width, height, textPreview, uploaderSub, uploaderName],
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
// E5.1 Wave H (H3): a REAL, browser-decodable video, not the old `Buffer.from("fake mp4 bytes")` -
// otherwise this state can never distinguish a player that genuinely decodes from one that only LOOKS
// mounted (finding 5/D-164's exact failure mode, which shipped invisibly behind D-79 sign-offs that all
// used fake bytes). Same VP9 fixture e2e/video-playback.spec.ts uses, for the same reason: Playwright's
// bundled Chromium has no H.264 decoder at all.
const VIDEO_FIXTURE_BYTES = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e", "fixtures", "clip.webm"),
);
const video = await seed(conn, { relPath: `vis-${run}/clip.webm`, bytes: VIDEO_FIXTURE_BYTES });
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
// E5 Wave E (D-141): deliberately ABOVE the 256KB full-preview cap, so PreviewCard's snippet+download
// fallback (the OTHER branch TextPreview can render) gets its own visual-check state too, not just the
// below-cap "full preview" case the existing `txt` fixture (well under the cap) now exercises.
const bigTxt = await seed(conn, {
  relPath: `vis-${run}/big-log.txt`,
  bytes: Buffer.alloc(300 * 1024, "x"),
  textPreview: "first line of a much larger log file...",
});
const zip = await seed(conn, { relPath: `vis-${run}/archive.zip`, bytes: Buffer.from("PK fake zip") });
// E5 AC10 / E5.1 Waves 0+C: the uploader block ("uploaded <when> by <avatar> <name>"). This is the page
// state E5's own definition of done named first and the only one the list was still missing - added by
// the E5/E5.1 review session (2026-08-04). Two fixtures, because D-168 made the two halves independent:
// a captured `name` renders it, and no name falls back to the raw sub. Both must LOOK right, since
// showing a sub is now deliberate rather than a bug.
const uploaded = await seed(conn, {
  relPath: `vis-${run}/uploaded-by-someone.png`,
  bytes: PNG_1PX,
  width: 1200,
  height: 800,
  uploaderSub: "google:118273645500192837465",
  uploaderName: "Hannah",
});
const uploadedNoName = await seed(conn, {
  relPath: `vis-${run}/uploaded-by-nameless.png`,
  bytes: PNG_1PX,
  width: 1200,
  height: 800,
  uploaderSub: "google:118273645500192837465",
});
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

async function seedBrowserFile(collectionId, name, ownerSub, protection = "public", { thumb = false } = {}) {
  const fileId = newId();
  const diskDir = "2026/07";
  const diskName = `${fileId}-${name}`;
  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "browser fixture bytes");
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  // D-137 (E5): `thumbName` mirrors thumbNameFor(fileId) exactly. E5.1 Wave H: dl.mosni.dev now has a real
  // TLS listener in this tier (nginx-e2e's self-signed cert), so this thumbnail's bytes (a real 1x1 PNG,
  // see PNG_1PX below) genuinely load through it - this state validates both that a listing row renders an
  // <img>, not the generic file icon, once thumbUrl is non-null, AND that the image actually decodes.
  const thumbName = thumb ? `${fileId}-thumb.webp` : null;
  if (thumb) await writeFile(path.join(STORAGE_ROOT, diskDir, thumbName), PNG_1PX);
  await conn.execute(
    `INSERT INTO files (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub, thumb_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?)`,
    [fileId, collectionId, name, diskDir, diskName, 21, protection, linkToken, ownerSub, thumbName],
  );
  return fileId;
}

// D-94: a small public tree, so an anonymous visitor's Browse tab has something to show. `browserNested`
// is what E4.1 Wave C's own collection page (/f/<path>) - not a client-side drill - renders its
// breadcrumb for.
const browserRoot = await seedBrowserCollection({ name: `vis-${run}-public`, ownerSub: WRITER.sub, protection: "public" });
await seedBrowserFile(browserRoot, "welcome.txt", WRITER.sub, "public");
// E5 (D-137): a row with a thumbnail, so the listing renders an <img> instead of the generic file icon.
await seedBrowserFile(browserRoot, "thumbed-photo.jpg", WRITER.sub, "public", { thumb: true });
const browserNested = await seedBrowserCollection({ parentId: browserRoot, name: "nested", ownerSub: WRITER.sub, protection: "public" });
await seedBrowserFile(browserNested, "deep-file.txt", WRITER.sub, "public");
// WRITER's own collection with a nested child + files, for the recursive-delete confirmation state (D-104)
// and E4.1 Wave B's row overflow menu.
const deletableTop = await seedBrowserCollection({ name: `vis-${run}-deletable`, ownerSub: WRITER.sub });
const deletableChild = await seedBrowserCollection({ parentId: deletableTop, name: "child", ownerSub: WRITER.sub });
await seedBrowserFile(deletableTop, "top-file.txt", WRITER.sub, "unlisted");
await seedBrowserFile(deletableChild, "child-file.txt", WRITER.sub, "unlisted");
// E4.1 Wave E: a collection owned by neither WRITER nor the admin, unlisted so it is invisible under
// scope=mine and scope=public alike - only scope=all's root listing (D-101) shows it, which is what
// "browser-admin-all" now demonstrates. E4.1 Wave C fixed collection ROUTES (/f/<path>) to scope=public
// always, so admin visibility can no longer be shown by drilling into a collection from the All files tab
// (that navigates away from scope=all entirely) - it has to be a root-listing difference instead.
const strangerCollection = await seedBrowserCollection({
  name: `vis-${run}-stranger-owned`,
  ownerSub: "user:visual-check-stranger",
  protection: "unlisted",
});
await seedBrowserFile(strangerCollection, "someone-elses-file.txt", "user:visual-check-stranger", "unlisted");

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
async function mintToken(sub, roles = "files:write", mosniOwner = false) {
  const idp = process.env.MOCK_IDP ?? "http://mock-idp:9000";
  const qs = `sub=${encodeURIComponent(sub)}&roles=${encodeURIComponent(roles)}${mosniOwner ? "&mosni_owner=true" : ""}`;
  const res = await fetch(`${idp}/token?${qs}`);
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
    note: "THE product surface (D-1). E4.1 Wave D/D-114: the drop target and its Options now render as " +
      "ONE panel, Options permanently expanded (no more <details> disclosure) - this state's the check " +
      "for it, since the old collapsed-then-opened pair of states no longer applies.",
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
  {
    id: "preview-video",
    label: "Preview - video",
    url: `/f/${video.relPath}`,
    note: "E5 Wave F: the lazy-loaded Vidstack player (D-144), not a bare <video controls>. E5.1 Wave H: " +
      "the fixture is now a REAL, browser-decodable VP9 clip (H3) and dl.mosni.dev has a real TLS listener " +
      "in this tier, and a <video src> load is NOT subject to CORS (only a script-initiated fetch() is) - " +
      "so this state should show the player ACTUALLY DECODING, the strongest evidence this check can give " +
      "that D-164's regression has not returned. A bare unstyled <video> tag, or the download-card " +
      "fallback, is now a real finding worth investigating, not an expected sandbox artifact.",
  },
  { id: "preview-pdf", label: "Preview - PDF", url: `/f/${pdf.relPath}`, note: "iframe to dl. - the frame-src/frame-ancestors fix (D-77). An <iframe src> is not CORS-gated either, so this should now load for real too (E5.1 Wave H)." },
  {
    id: "preview-text",
    label: "Preview - text, full content (below the 256KB cap)",
    url: `/f/${txt.relPath}`,
    note: "E5 Wave E (D-141): renders via <mosni-code>, fetching the FULL file from dl. rather than the " +
      "400-char snippet. E5.1 Wave H: dl.mosni.dev has a real TLS listener now, but this is a script " +
      "fetch() (not an <img>/<video>/<iframe> src), so it IS subject to CORS - nginx's " +
      "Access-Control-Allow-Origin is hardcoded to the REAL \"https://files.mosni.dev\" (a mandatory " +
      "never-delete assertion, deliberately never rewritten for this tier - verification-concept.md), which " +
      "this tier's own origin (files-e2e.test) never matches. So the fetch still fails here, for a DIFFERENT " +
      "reason than before (CORS, not a dead transport) - the ingest snippet (seeded above) is still what " +
      "actually shows. A real deploy, running at the real files.mosni.dev, has no such mismatch.",
  },
  {
    id: "preview-text-above-cap",
    label: "Preview - text, above the 256KB cap (snippet + download fallback)",
    url: `/f/${bigTxt.relPath}`,
    note: "E5 Wave E (D-141): the OTHER TextPreview branch - no fetch attempt at all, just the ingest " +
      "snippet plus a 'Download to view in full' action.",
  },
  { id: "preview-download-card", label: "Preview - download card", url: `/f/${zip.relPath}`, note: "Non-inline type falls back to the download card" },
  {
    id: "preview-uploader",
    label: "Preview - uploader block, with a captured name (E5 AC10)",
    url: `/f/${uploaded.relPath}`,
    note:
      "The 'uploaded <when> by <avatar> <name>' line. SANDBOX ARTIFACT: the avatar <img> points at " +
      "AUTH_ISSUER/avatar/<sub>, which is the e2e mock IdP here and is also absent from img-src, so it " +
      "cannot load - PreviewCard hides it on error, so judge the NAME and the line's layout, not the " +
      "missing image. The avatar itself is a box-only check against a live auth.mosni.dev.",
  },
  {
    id: "preview-uploader-no-name",
    label: "Preview - uploader block, no name captured: the sub is shown (D-168)",
    url: `/f/${uploadedNoName.relPath}`,
    note:
      "D-168 made the sub fallback UNCONDITIONAL, so a raw provider sub is now shown to every viewer on " +
      "purpose (Hannah's explicit call, reversing D-155). This state exists so how that READS stays " +
      "visible on every review, since it is a deliberate disclosure rather than a leak.",
  },
  { id: "preview-secret-token", label: "Preview - secret via /t/<token>", url: `/t/${secret.linkToken}`, note: "The only way to reach a secret file (D-59)" },
  { id: "preview-private-anon", label: "Preview - private, signed out", url: `/f/${priv.relPath}`, note: "Must reveal nothing: shared not-found panel (D-72/D-75)" },
  { id: "notfound-secret-path", label: "404 - secret at its readable path", url: `/f/${secret.relPath}`, note: "Must 404, never 403 (D-59, never-delete)", expectStatuses: [404] },
  { id: "notfound-missing", label: "404 - nonexistent path", url: `/f/vis-${run}/does-not-exist.png`, note: "Styled NotFound view (P1)", expectStatuses: [404] },
  {
    id: "landing-completed-upload",
    label: "Landing - signed in, upload just completed (job stack item + the listing refreshing itself)",
    url: "/",
    note: "D-122: on completion the floating job stack shows the finished upload (view + copy, dismissible) " +
      "- the inline compact PreviewCard this state used to wait for was REMOVED by D-122, and E5.1 Wave E " +
      "(D-161) moved the stack out of DropZone and mounted it once. Also the live proof of AC-E1/finding 4: " +
      "the listing below must gain the new row with no manual refresh. The image's dl.mosni.dev subresource " +
      "is expected to fail in this sandbox (no live dl. origin) - a sandbox artifact, not a defect.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.locator('input[type="file"]').setInputFiles({
        name: `vis-${run}-drop.png`,
        mimeType: "image/png",
        buffer: PNG_1PX,
      });
      // The stack item reaching its "done" shape is the completion signal (D-122's `view` link replaced the
      // old copy-field). Fixed by the E5/E5.1 review session (039): the previous selector had been stale
      // since D-122, and its timeout was swallowed - the state screenshotted mid-upload for months.
      await p.locator(".job-stack .panel a", { hasText: "view" }).first().waitFor({ state: "visible", timeout: 30_000 });
      // AC-E1: the listing refetches itself off the shared reload signal - wait for the row, don't assume it.
      await p.locator("table").getByText(`vis-${run}-drop.png`).first().waitFor({ state: "visible", timeout: 15_000 });
      await p.waitForTimeout(500);
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
    id: "preview-owner-controls",
    label: "Preview - owner, the manage controls (rename / protection / delete)",
    url: `/f/${owned.relPath}`,
    note: "D-89: rename form, protection selector and the Delete button, all owner-only. Requires the " +
      "background /api/preview refetch (with a real Bearer) to confirm isOwner - the embedded document " +
      "copy is always isOwner:false (D-75), so this state only appears after that round trip settles.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      // Fixed by the E5/E5.1 review session (039): `text=Delete file` matches TEXT CONTENT, and E4.1's
      // header redesign made rename/delete ICON-ONLY buttons whose "Delete file" lives in aria-label - so
      // this waited 10s and swallowed the miss on every run since. getByRole matches the accessible name.
      await p.getByRole("button", { name: "Delete file" }).waitFor({ state: "visible", timeout: 15_000 });
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
      // Same stale-selector fix as preview-owner-controls above (review session 039) - the affordance is an
      // icon button, so its name is the accessible name, never its text content.
      await p.getByRole("button", { name: "Delete file" }).click({ timeout: 15_000 });
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
    label: "Collection page - a nested collection, opened cold (breadcrumb)",
    url: `/f/vis-${run}-public/nested`,
    note: "E4.1 Wave C (C2/C3/C4): a collection is now a real route, not a client-side drill - this opens " +
      "the nested collection COLD, the way a shared link actually arrives. The breadcrumb (Home / " +
      "vis-<run>-public / nested) must be present. D-121 (E4.1 Wave E findings) STRUCK the old rule that " +
      "the current crumb be plain text: EVERY crumb, 'nested' included, is now a plain purple <a href> " +
      "with no border - a bordered pill, or a non-link current crumb, is the defect now. No drop zone or " +
      "tabs on this page (D-107: collection routes are " +
      "view-only) - that is the whole point of the redesign, not a bug in this check.",
    init: signedOut,
    interact: async (p) => {
      await p.waitForSelector("text=deep-file.txt", { timeout: 10_000 }).catch(() => {});
    },
  },
  {
    id: "browser-row-overflow-menu",
    label: "Landing - browser section, an opened row overflow menu",
    url: "/",
    note: "E4.1 Wave B/D-109: per-row actions (copy link, rename, protection, delete) live behind a " +
      "trailing <mosni-dropdown>, not inline. This opens one on the signed-in owner's own row so every " +
      "manage action is visible in the same shot.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector(`[data-row-id]:has-text("vis-${run}-deletable")`, { timeout: 10_000 }).catch(() => {});
      const row = p.locator("[data-row-id]", { hasText: `vis-${run}-deletable` });
      await row.locator("mosni-dropdown .dropdown-trigger").click({ timeout: 5_000 }).catch(() => {});
      await p.waitForTimeout(150);
    },
  },
  {
    id: "browser-admin-browse",
    label: "Landing - browser section, an admin's Browse tab (D-116)",
    url: "/",
    note: "D-116 REPLACED this state's predecessor (browser-admin-all). There is no longer an 'All files' " +
      "tab to click: scope=all and scope=public were deleted, and Browse means scope=visible for EVERY " +
      "viewer. What this shot proves is that an admin sees the same two tabs as anyone else (My files / " +
      "Browse) and nonetheless sees a stranger-owned unlisted collection at root INSIDE Browse - i.e. the " +
      "breadth comes from the server knowing they are an admin, not from a special tab. A third tab " +
      "appearing here, or the stranger-owned row being absent, is a real defect.",
    init: signedInAsReal(ADMIN, adminToken),
    interact: async (p) => {
      await p.waitForSelector("mosni-tabs", { timeout: 10_000 }).catch(() => {});
      await p.locator("mosni-tabs button", { hasText: "Browse" }).click({ timeout: 5_000 }).catch(() => {});
      await p.waitForSelector(`text=vis-${run}-stranger-owned`, { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(200);
    },
  },
  {
    id: "browser-row-rename-inline",
    label: "Landing - browser section, inline rename open on a row",
    url: "/",
    note: "E4.1 Wave E findings C8 (finding 10): rename edits the NAME CELL in place - an input in the " +
      "name column plus check/x icon buttons where the row's actions normally sit - instead of the old " +
      "expanded <tr> below the row. This state did not exist before, which is exactly why finding 10 " +
      "could only ever be verified in code. The input must carry the design system's input chrome (it is " +
      "wrapped in .field, C5's same fix) - an unstyled native input here is the defect.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector(`[data-row-id]:has-text("vis-${run}-deletable")`, { timeout: 10_000 }).catch(() => {});
      const row = p.locator("[data-row-id]", { hasText: `vis-${run}-deletable` });
      await row.locator("mosni-dropdown .dropdown-trigger").click({ timeout: 5_000 }).catch(() => {});
      await row.locator("mosni-dropdown-item", { hasText: "Rename" }).click({ timeout: 5_000 }).catch(() => {});
      await p.waitForTimeout(200);
    },
  },
  {
    id: "browser-new-collection-placeholder",
    label: "Landing - browser section, the new-collection placeholder row",
    url: "/",
    note: "E4.1 Wave E findings C10/D-118 (finding 12): the permanent bordered create-collection form is " +
      "gone; 'New collection' is a button that inserts a client-side-only placeholder row at the top of " +
      "the table. The input starts EMPTY with placeholder text, and the confirm (check) button is " +
      "DISABLED until a name is typed - both are visible in this shot and both are the decision D-118 " +
      "recorded. No server call has happened at this point.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector("mosni-tabs", { timeout: 10_000 }).catch(() => {});
      await p.locator("button", { hasText: "New collection" }).first().click({ timeout: 5_000 }).catch(() => {});
      await p.waitForTimeout(200);
    },
  },
  {
    id: "browser-row-protection-panel",
    label: "Landing - browser section, a row's protection panel open",
    url: "/",
    note: "E4.1 Wave E findings C5 (finding 8): ProtectionControl relied on being rendered inside a " +
      ".panel for its native <select>'s styling, and E4.1 Wave B moved it into a bare <td>, so it " +
      "rendered completely unstyled. It is now wrapped in mosni-chrome's .field, which styles a " +
      "descendant select independent of .panel. No visual-check state opened this panel before, which is " +
      "why finding 8 was code-only. An unstyled browser-default select here is the defect.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector(`[data-row-id]:has-text("vis-${run}-deletable")`, { timeout: 10_000 }).catch(() => {});
      const row = p.locator("[data-row-id]", { hasText: `vis-${run}-deletable` });
      await row.locator("mosni-dropdown .dropdown-trigger").click({ timeout: 5_000 }).catch(() => {});
      await row.locator("mosni-dropdown-item", { hasText: "Protection" }).click({ timeout: 5_000 }).catch(() => {});
      await p.waitForTimeout(200);
    },
  },
  {
    id: "browser-collection-delete-confirm",
    label: "Landing - browser section, the recursive collection-delete confirmation",
    url: "/",
    note: "D-104/D-88: recursive collection delete gets its own confirmation naming the descendant count - " +
      "the most destructive operation in the app. This run only opens the confirmation (a dryRun fetch), " +
      "it never clicks \"Yes, delete\", so the fixture survives for the next run. E4.1 Wave B moved Delete " +
      "behind the row's overflow menu (D-109) - open that first.",
    init: signedInAsReal(WRITER, uploadToken),
    interact: async (p) => {
      await p.waitForSelector(`[data-row-id]:has-text("vis-${run}-deletable")`, { timeout: 10_000 }).catch(() => {});
      const row = p.locator("[data-row-id]", { hasText: `vis-${run}-deletable` });
      await row.locator("mosni-dropdown .dropdown-trigger").click();
      await row.locator("mosni-dropdown-item", { hasText: "Delete" }).click();
      await p.waitForSelector("text=This can't be undone.", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(150);
    },
  },
  {
    id: "embed-player-route",
    label: "Embeddable player route (E5 Wave H, D-140)",
    url: `/embed/f/${video.relPath}`,
    note: "No app chrome at all - no <mosni-header>, no auth SDK script tags (H1). Same lazy Vidstack " +
      "player as the ordinary preview page, same real-decode expectation since E5.1 Wave H - see " +
      "preview-video's note.",
  },
  {
    id: "embed-player-route-rejected",
    label: "Embeddable player route - a private file must 404 (H2, never-delete)",
    url: `/embed/f/${priv.relPath}`,
    note: "The styled NotFound view, not a player - a private (or secret) file must never render here " +
      "even though its ordinary /f/ path would 200 anonymously with a reveal-nothing shell.",
    expectStatuses: [404],
  },
];

const browser = await chromium.launch();
const results = [];
const overflowFailures = [];

try {
  // E5.1 Wave H (H4/D-163): ABORT before writing a single screenshot if the design system has not
  // actually loaded. Session 022 found every D-79 screenshot ever taken up to that point had rendered
  // with no design system at all (78 signed off); session 035 hit the EXACT same trap again despite the
  // written warning - a comment has now failed to prevent this twice, so it becomes a hard check. Uses
  // the same two probes session 022 used to measure the original gap.
  const preflightContext = await browser.newContext(IGNORE_TLS);
  const preflightPage = await preflightContext.newPage();
  await preflightPage.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await preflightPage.waitForTimeout(700);
  const designSystem = await preflightPage.evaluate(() => ({
    tabsRegistered: typeof customElements.get("mosni-tabs") !== "undefined",
    styleSheetCount: document.styleSheets.length,
  }));
  await preflightContext.close();
  if (!designSystem.tabsRegistered || designSystem.styleSheetCount === 0) {
    throw new Error(
      "visual-check ABORTED before writing any screenshot: the design system did not load " +
        `(customElements.get("mosni-tabs") ${designSystem.tabsRegistered ? "is" : "is NOT"} registered, ` +
        `document.styleSheets.length=${designSystem.styleSheetCount}). A screenshot that cannot show the ` +
        "design system is not weak evidence about appearance - it is ZERO evidence, and worse than none " +
        "because it looks like evidence (session 022, repeated session 035 despite a written warning).",
    );
  }

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
      let interactError = null;
      try {
        const res = await p.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
        status = res?.status() ?? null;
        // The SPA paints from the embedded context on the first frame; a private/missing file has none
        // and must round-trip to the API first, so give the client state machine a moment to settle.
        await p.waitForTimeout(700);
        if (page.interact) {
          // Recorded separately from a navigation failure: a state whose `interact` did not complete is a
          // screenshot of the WRONG state, which is the D-163 family this check exists to make loud.
          try {
            await page.interact(p);
          } catch (err) {
            interactError = err;
            throw err;
          }
        }
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

      // E5/E5.1 review session (039): an `interact` that did not complete means the page is NOT in the
      // state this entry names - the delete-confirmation was never opened, the upload never finished, the
      // menu never opened. Until now that was swallowed into the title string and a screenshot of the
      // pre-interaction page was written and signed off anyway; TWO states (landing-completed-upload,
      // preview-delete-confirm) had been doing exactly that, undetected, since D-122 and E4.1's icon-only
      // header respectively. Same rule as the status guard below and the design-system guard above: a
      // check that cannot tell "I captured the state" from "I captured a failure" is worse than one that
      // fails loudly.
      if (interactError !== null) {
        throw new Error(
          `visual-check ABORTED: ${page.id} @ ${vp.name} - its interact step failed, so the page is not in ` +
            `the state this entry describes and no screenshot was written for it. Underlying error: ` +
            `${interactError.message.split("\n")[0]}. If the UI legitimately changed, update this entry's ` +
            "selectors - do NOT relax this guard.",
        );
      }

      // E5.1 Wave H (fold-in, review session 037's VISUAL-CHECK-PASSES-ON-429 finding): a state that
      // expects 2xx and gets anything else - most likely the global rate limiter
      // (E5-DELIVERY-RATE-LIMIT/E5.1-E2E-RATE-LIMIT) - must ABORT the run, not be written to disk as if it
      // were the real page. Measured: 13 of 30 mobile states came back 429 in one full run and were
      // captured and reported success anyway. Same D-163 family as the design-system guard above: a check
      // that cannot tell "I captured the page" from "I captured a failure" is worse than one that fails
      // loudly.
      const expected = page.expectStatuses ?? [200];
      if (status !== null && !expected.includes(status)) {
        throw new Error(
          `visual-check ABORTED: ${page.id} @ ${vp.name} returned HTTP ${status}, expected one of ` +
            `[${expected.join(", ")}]. No screenshot was written for this state, and the run stops here ` +
            "rather than producing a partial, silently-wrong sign-off set. If this is the rate limiter, " +
            "re-run once its window has passed - see E5-DELIVERY-RATE-LIMIT / E5.1-E2E-RATE-LIMIT.",
        );
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
