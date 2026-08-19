import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ensureSharedDir } from "./seedStorage.ts";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// E7 Wave E2: private sharing driven through the real production image, real MariaDB, real nginx. The
// mock IdP can sign a SECOND identity (any `sub` it's asked for), which is exactly what makes the core
// share round trip testable end to end here: user A owns a private file, user B is denied, A grants B,
// B is let in, A revokes, B is denied again - all against the real delivery controller, not a stub.

const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `https://${FILES_HOST}`;
const STORAGE_ROOT = "/data/storage";

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string, roles = "files:write") {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=${encodeURIComponent(roles)}`);
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

async function seedPrivateFile(conn: mysql.Connection, opts: { name: string; ownerSub: string }): Promise<{ id: string }> {
  const id = newId();
  const diskDir = "2026/08";
  const diskName = `${id}-${opts.name}`;
  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  // Review 060/SEC-2: shared-writable, because app-e2e writes this same directory as uid 1000.
  await ensureSharedDir(path.dirname(abs));
  await writeFile(abs, "e7 share e2e fixture bytes");
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    `INSERT INTO files (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub)
     VALUES (?, '', ?, ?, ?, 26, 'private', ?, 'committed', ?)`,
    [id, opts.name, diskDir, diskName, linkToken, opts.ownerSub],
  );
  return { id };
}

test("grant -> real delivery goes 403 -> 200; revoke -> 200 -> 403 again (E7 core round trip)", async ({ request }) => {
  const run = randomUUID().slice(0, 8);
  const ownerSub = `user:e2e-share-owner-${run}`;
  const granteeSub = `user:e2e-share-grantee-${run}`;
  const fileName = `private-${run}.txt`;

  const file = await withDb((conn) => seedPrivateFile(conn, { name: fileName, ownerSub }));

  const ownerToken = await mintToken(request, ownerSub);
  const granteeToken = await mintToken(request, granteeSub);

  // B is denied before any grant exists.
  const before = await request.get(`https://dl.mosni.dev/${fileName}`, {
    headers: { authorization: `Bearer ${granteeToken}` },
  });
  expect(before.status()).toBe(403);

  // A grants B.
  const grant = await request.post(`${FILES_ORIGIN}/api/shares`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: { type: "file", id: file.id, sub: granteeSub },
  });
  expect(grant.status(), await grant.text()).toBe(200);

  // B is let in, and the bytes match what was actually stored.
  const after = await request.get(`https://dl.mosni.dev/${fileName}`, {
    headers: { authorization: `Bearer ${granteeToken}` },
  });
  expect(after.status()).toBe(200);
  expect(await after.text()).toBe("e7 share e2e fixture bytes");

  // A revokes.
  const revoke = await request.post(`${FILES_ORIGIN}/api/shares/revoke`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: { type: "file", id: file.id, sub: granteeSub },
  });
  expect(revoke.status(), await revoke.text()).toBe(200);

  // B is denied again.
  const afterRevoke = await request.get(`https://dl.mosni.dev/${fileName}`, {
    headers: { authorization: `Bearer ${granteeToken}` },
  });
  expect(afterRevoke.status()).toBe(403);
});

test("GET /api/accounts: 401 anonymous, 403 without files:write", async ({ request }) => {
  const anon = await request.get(`${FILES_ORIGIN}/api/accounts`);
  expect(anon.status()).toBe(401);

  const run = randomUUID().slice(0, 8);
  const noWriteToken = await mintToken(request, `user:e2e-no-write-${run}`, "");
  const noWrite = await request.get(`${FILES_ORIGIN}/api/accounts`, {
    headers: { authorization: `Bearer ${noWriteToken}` },
  });
  expect(noWrite.status()).toBe(403);
});

test("a grantee cannot grant, revoke or invite on the object shared with them (D-187)", async ({ request }) => {
  const run = randomUUID().slice(0, 8);
  const ownerSub = `user:e2e-share-owner2-${run}`;
  const granteeSub = `user:e2e-share-grantee2-${run}`;
  const fileName = `private2-${run}.txt`;

  const file = await withDb((conn) => seedPrivateFile(conn, { name: fileName, ownerSub }));
  const ownerToken = await mintToken(request, ownerSub);
  const granteeToken = await mintToken(request, granteeSub);

  const grant = await request.post(`${FILES_ORIGIN}/api/shares`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: { type: "file", id: file.id, sub: granteeSub },
  });
  expect(grant.status()).toBe(200);

  const granteeTriesToGrant = await request.post(`${FILES_ORIGIN}/api/shares`, {
    headers: { authorization: `Bearer ${granteeToken}` },
    data: { type: "file", id: file.id, sub: `user:third-${run}` },
  });
  expect(granteeTriesToGrant.status()).toBe(404);

  const granteeTriesToInvite = await request.post(`${FILES_ORIGIN}/api/invites`, {
    headers: { authorization: `Bearer ${granteeToken}` },
    data: { type: "file", id: file.id },
  });
  expect(granteeTriesToInvite.status()).toBe(404);
});

// E7-QA1 live-testing round 2: Hannah minted an invite with upload allowed, claimed it in a fresh session,
// and got "Your account does not have permission to upload files." The server-side grant was correct
// (app/test/integration/upload.test.ts's own D-196 block already proves a can_upload-only tus request
// succeeds) - the break was client-side only, and invisible to every tier before this one: FileBrowser.tsx
// correctly asks the SERVER whether this viewer may upload (`data.canUpload`, D-116) before mounting a
// compact DropZone, but DropZone.tsx's OWN internal gate re-checked the files:write ROLE regardless, which
// a can_upload-only grantee (an invite claimant, or any direct ACL grant - D-182 stopped adding a role for
// either) never has by design. web/test/unit/landingPageJobs.test.tsx's own compact-mount test used
// `roles: ["files:write"]` in its mock, which made that exact role check pass by coincidence and hid the
// bug from every tier below this one - real proof needs a real browser rendering the real DropZone with NO
// files:write role, driving an actual tus upload through the real production image.
test("a can_upload-only grantee (no files:write role) can upload into a shared collection via a real browser drop (F9/D-196)", async ({
  page,
  request,
}) => {
  const run = randomUUID().slice(0, 8);
  const ownerSub = `user:e2e-upload-owner-${run}`;
  const granteeSub = `user:e2e-upload-grantee-${run}`;
  const collectionName = `grant-upload-${run}`;
  const filename = `grantee-drop-${randomUUID().slice(0, 8)}.txt`;
  const body = `uploaded by a can_upload-only grantee ${randomUUID()}`;

  const collectionId = await withDb(async (conn) => {
    const id = newId();
    const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
    await conn.execute(
      `INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token)
       VALUES (?, '', ?, ?, 'public', 'public', ?)`,
      [id, collectionName, ownerSub, linkToken],
    );
    // The ACL row IS the grant (D-182) - no role is ever added for it, which is the exact shape a claimed
    // invite produces (controllers/share.ts's createInviteHandler grants the SAME way).
    await conn.execute("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 1)", [
      id,
      granteeSub,
    ]);
    return id;
  });

  // `""` roles - deliberately no files:write, matching a fresh invite claimant/grantee exactly.
  const granteeToken = await mintToken(request, granteeSub, "");

  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(`
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => ({ sub: ${JSON.stringify(granteeSub)}, roles: [] }),
      token: () => ${JSON.stringify(granteeToken)},
      onChange: (cb) => cb({ sub: ${JSON.stringify(granteeSub)}, roles: [] }),
      login: () => {}, logout: () => {},
      toast: (m) => { window.__toast = m; },
    });
  `);

  await page.goto(`${FILES_ORIGIN}/f/${collectionName}`);

  // The exact regression: this used to render "No upload access" here despite the server-side grant.
  await expect(page.getByText("No upload access")).toHaveCount(0);
  const picker = page.locator('[role="button"] input[type="file"]');
  await expect(picker).toBeAttached({ timeout: 20_000 });

  await picker.setInputFiles({ name: filename, mimeType: "text/plain", buffer: Buffer.from(body) });

  const stackItem = page.locator(".panel", { hasText: filename });
  const viewLink = stackItem.locator("a", { hasText: "view" });
  await expect(viewLink).toBeVisible({ timeout: 30_000 });

  // Landed in the collection the grant was scoped to, not somewhere else.
  const shareUrl = await viewLink.getAttribute("href");
  expect(shareUrl).toContain(`/${collectionName}/`);
  const preview = await request.get(`${FILES_ORIGIN}${new URL(shareUrl!).pathname}`, { headers: { host: FILES_HOST } });
  expect(preview.status()).toBe(200);
  expect(await preview.text()).toContain(filename);

  await withDb(async (conn) => {
    const [rows] = await conn.execute("SELECT collection_id FROM files WHERE name = ?", [filename]);
    expect((rows as { collection_id: string }[])[0]?.collection_id).toBe(collectionId);
  });
});

// Review session 045. Hannah hit a full React crash - white screen - opening the share dialog on the box,
// and nothing in any tier caught it. This block is the reason why, and the fix.
//
// Wave E2 built share.spec.ts as three `{ request }` tests: the grant/revoke round trip, the /api/accounts
// gate, and D-187. All three are API-level. Every other feature in this app has `page` tests; E7's client
// shipped with NONE, so acceptance criteria 5, 9, 10, 14, 15 and 19 - the entire dialog - were never once
// opened in a browser by any automated tier.
//
// The original crash lived in the seam between React and a real registered custom element: mosni-chrome's
// MosniModal MOVED its light-DOM children into a <dialog> it built (`takeSlot`/`takeDefault` called
// `child.remove()`), so React's recorded parent for those nodes went stale and the next swap of one threw
// NotFoundError in React's commit phase, tearing down the whole root. Same class as session 021's
// production `mosni-tab label` crash.
//
// E7.5 (D-212/D-214): ShareDialog now mounts @mosni/react's `<Modal>`, `<Switch>` and `<Slider>` - real
// components that portal a real `<dialog>` to `document.body` and never hand a custom element any React
// children, so the exact hazard this block was built for cannot recur here any more (see D-214's narrowed
// invariant). The block stays anyway, for the same reason browse.spec.ts's own "real mosni-chrome
// integration" block stays: it is now the guard that this dialog opens against the REAL deployed
// stylesheet (ui.mosni.dev/mosnicat.js, not a stub) with zero uncaught page errors, which is still worth
// having and is cheap. Hence the identical shape here: ignoreHTTPSErrors so the real script loads through
// the sandbox proxy, scoped with test.use to just this block, with retries for that one genuine external
// fetch (real network flakiness passes on a retry; a genuine regression fails identically every time).
test.describe("real mosni-chrome integration: the share dialog must OPEN without crashing React", () => {
  test.use({ ignoreHTTPSErrors: true });
  test.describe.configure({ retries: 2 });

  test("opening Share on a private file renders the dialog with zero uncaught page errors", async ({ page, request }) => {
    const sub = `user:e2e-share-ui-${randomUUID()}`;
    const token = await mintToken(request, sub);
    const name = `share-ui-${randomUUID().slice(0, 8)}.txt`;
    await withDb((conn) => seedPrivateFile(conn, { name, ownerSub: sub }));

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // Only sdk.js is blocked (it needs a live auth.mosni.dev); mosnicat.js loads for REAL, which is the
    // entire point - a stubbed design system cannot reproduce this.
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

    // The row's overflow menu -> Share. Waiting on the row first proves the browser actually rendered
    // before we start clicking, so a failure below is the dialog's and not a slow listing's.
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Review 060/ADD-1: scoped to THIS file's own row, never `.first()` on the page. The landing page now
    // opens on Browse rather than My files, so the listing contains every other spec's visible fixtures
    // too - `.first()` opened whichever row happened to sort first, which for a file this viewer does not
    // own has no Share item at all, and the click timed out waiting for one.
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "Share" }).click();

    // The dialog must mount, real DOM built by <Modal>'s own render (a real <dialog class="modal"> React
    // itself portals to document.body - see the block comment above for why the D-8 crash class this test
    // was built for no longer applies to this call site).
    // Scoped by heading: every row mounts THREE modals (Delete, Move, Share), so a bare `dialog.modal`
    // would be a strict-mode violation, not a signal.
    const shareModal = page
      .locator("dialog.modal")
      // Review 060/ADD-1: scoped to THIS file's heading, not just /^Share/. The comment above is right
      // that a bare `dialog.modal` is a strict-mode violation - but so is a Share-only filter now that
      // the landing page opens on Browse, because EVERY listed row mounts its own Share modal. The
      // filename is what makes it one element again.
      .filter({ has: page.locator(".modal-heading", { hasText: `Share "${name}"` }) });
    await expect(shareModal).toBeAttached({ timeout: 20_000 });

    // THEN the dialog must reach its LOADED state, not just mount - the crash this block guards against
    // happens on the spinner -> content swap, so asserting the spinner alone would pass while the app is
    // already dead.
    await expect(page.getByText("Add people")).toBeVisible({ timeout: 20_000 });

    // The real assertion. A NotFoundError in React's commit phase unmounts the root, so the surest
    // symptom is that the page still has its listing AND that nothing was thrown.
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(", ")}`).toEqual([]);
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  });

  // ⚠ Added by review session 055, and it is the cell E7.5 left blank. Dismissal used to be OWNED by this
  // repo: `lib/modalClose.ts` listened for the element's own `close`/`mosni-modal-close` events, and F7
  // (E7-QA1 §C2) is the real bug that came of getting it wrong - a dialog that closed itself left React's
  // `open` stuck true and the modal never reopened. E7.5 deleted that hook and moved dismissal into
  // `<Modal>`: ESC is now the NATIVE <dialog>'s own behaviour, and the backdrop is an `onPointerDown`
  // comparing `event.target === event.currentTarget`. Neither of those can be reached from jsdom - the unit
  // tier's polyfill (web/test/setup.ts) implements neither, so ShareDialog.test.tsx's F7 test dispatches a
  // synthetic `close` event and therefore only proves the wiring DOWNSTREAM of a dismissal that already
  // happened. The hand-off asked for both paths as a human hand-walk instead; a hand-walk is not a guard
  // (HANDOFF.md: "an invariant whose only enforcement is a procedure is not enforced"), so here it is at
  // the one tier that can actually produce the gestures.
  //
  // Proven red-then-green: replacing <Modal onClose={onClose}> in ShareDialog.tsx with a no-op fails both
  // halves (the dialog closes natively, React never hears, and the reopen below is a no-op) - which is F7
  // exactly.
  test("the share dialog closes by ESC and by a backdrop click, and reopens afterwards (F7)", async ({
    page,
    request,
  }) => {
    const sub = `user:e2e-share-dismiss-${randomUUID()}`;
    const token = await mintToken(request, sub);
    const name = `share-dismiss-${randomUUID().slice(0, 8)}.txt`;
    await withDb((conn) => seedPrivateFile(conn, { name, ownerSub: sub }));

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

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
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const shareModal = page
      .locator("dialog.modal")
      // Review 060/ADD-1: scoped to THIS file's heading, not just /^Share/. The comment above is right
      // that a bare `dialog.modal` is a strict-mode violation - but so is a Share-only filter now that
      // the landing page opens on Browse, because EVERY listed row mounts its own Share modal. The
      // filename is what makes it one element again.
      .filter({ has: page.locator(".modal-heading", { hasText: `Share "${name}"` }) });
    const openShare = async () => {
      // Review 060/ADD-1: this file's own row, not `.first()` - see the note in the first test above.
      await row.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole("menuitem", { name: "Share" }).click();
      await expect(shareModal).toHaveAttribute("open", /.*/, { timeout: 20_000 });
    };

    // 1. ESC. `open` is the native HTMLDialogElement IDL attribute, so this is the DOM's own ground truth
    //    for "the dialog closed", not a class or a React-rendered string.
    await openShare();
    await page.keyboard.press("Escape");
    await expect(shareModal).not.toHaveAttribute("open", /.*/);

    // 2. ...and it reopens. This is the half F7 broke: a self-close React never heard about leaves `open`
    //    stuck true, so the next click sets it true again and nothing happens.
    await openShare();

    // 3. The backdrop. A modal <dialog>'s backdrop hit-tests as the dialog element ITSELF, which is what
    //    <Modal>'s `event.target === event.currentTarget` check keys on - so a click in the far corner,
    //    outside the dialog's own box, is a real user's backdrop dismissal and not a synthetic stand-in.
    await page.mouse.click(5, 5);
    await expect(shareModal).not.toHaveAttribute("open", /.*/);

    // ...and again, from the backdrop route this time.
    await openShare();

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(", ")}`).toEqual([]);
  });

  // E7-QA1 §D3/F8: the headline finding of this round, proven in a REAL browser - a genuine navigation to
  // a private collection's deep link, which sends no Authorization header at all (that is what a browser
  // navigation is). Before this fix the document layer gated on that missing header and 404'd for
  // EVERYONE, including the owner; this test drives the exact request shape a real user's click produces,
  // never a fabricated header (D-200 applies to e2e assertions as much as integration ones).
  test("a private collection's deep link opens for its own owner via a real browser navigation (F8/D-197)", async ({ page, request }) => {
    const sub = `user:e2e-private-coll-${randomUUID()}`;
    const token = await mintToken(request, sub);
    const collectionName = `private-deep-link-${randomUUID().slice(0, 8)}`;

    await withDb(async (conn) => {
      const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
      await conn.execute(
        `INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token)
         VALUES (?, '', ?, ?, 'private', 'unlisted', ?)`,
        [newId(), collectionName, sub, linkToken],
      );
    });

    // Review session 052: THIS LINE WAS MISSING, and its absence is why this test has been red since it
    // was written. Every sibling test in this block aborts sdk.js; this one did not, so the genuine
    // `auth.mosni.dev/sdk.js` loaded and OVERWROTE the injected `window.mosni` stub with the real SDK -
    // which is unauthenticated in this sandbox, so the SPA's /api/browse call went out with no bearer,
    // and a private collection with no bearer is exactly the case D-197 correctly answers with nothing to
    // list. The breadcrumb then never renders and the assertion below times out at 20s.
    //
    // Session 047 diagnosed this EXACT mechanism while debugging its own ad-hoc repro script, fixed the
    // script, wrote "(the real test does)" about blocking sdk.js - and the real test did not. It then
    // recorded the remaining failure as sandbox rate-limit flakiness, which is what every session since
    // has inherited. Measured this session: it fails 3/3 alone on a freshly flushed limiter, and fails
    // identically against a pre-E7-QA2 build, so it was never contention and never a QA2 regression.
    // **The F8 fix itself is fine** - only its guard was broken.
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

    // A real top-level navigation - Playwright's page.goto() sends exactly what a browser sends on a
    // clicked link: no Authorization header. The auth SDK's token only becomes available to the SPA
    // AFTER this document has already loaded and mounted, via the client-side /api/browse call.
    await page.goto(`${FILES_ORIGIN}/f/${collectionName}`);

    // Before F8's fix this 404'd (the styled NotFound view) for every viewer including the owner. Now the
    // document always 200s with the reveal-nothing shell, and the SPA's own /api/browse call (WITH the
    // bearer, once the SDK resolves) is what actually authorizes the owner into the real listing.
    await expect(page.locator("nav[aria-label=Breadcrumb]")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("This file doesn't exist")).toHaveCount(0);
  });

  // Review session 049, closing the second half of the QA1 hand-off's §0.3 rule ("every new component
  // wrapping a mosni-* element needs BOTH tiers"). Round 2 added a wrapper for a brand-new element,
  // `<mosni-switch>`, and shipped only the unit tier.
  //
  // E7.5 (D-212): this is a real `<Switch>` (@mosni/react) now, not a wrapped custom element - there is no
  // reflect-then-bubble timing assumption left to prove, since `onChange` is React's own synthetic event
  // firing off a real `<input type="checkbox">`, the same as any other controlled form element in this
  // codebase. web/test/unit/ShareDialog.test.tsx already covers that wiring in jsdom, faithfully (a real
  // `<input>`, a real `change` event - nothing fabricated). This test stays for a narrower, still-real
  // reason: it is the only tier that opens the dialog against the ACTUAL deployed stylesheet, so it is
  // what proves D-23's consequence line renders legibly (not clipped) under the real CSS.
  //
  // It is not cosmetic: this switch is `allow_register`, and turning it off is D-23's shared WRITE
  // identity. A switch that silently reports a stale value sends the wrong `allow_register` to auth.
  test("the invite switch is a real <Switch> and its click reaches React state, against the real deployed stylesheet (F4/F13, D-198)", async ({
    page,
    request,
  }) => {
    const sub = `user:e2e-switch-${randomUUID()}`;
    const token = await mintToken(request, sub);
    const name = `switch-ui-${randomUUID().slice(0, 8)}.txt`;
    await withDb((conn) => seedPrivateFile(conn, { name, ownerSub: sub }));

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

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
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Review 060/ADD-1: this file's own row, not `.first()` - see the note in the first test above.
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "Share" }).click();
    await expect(page.getByText("Add people")).toBeVisible({ timeout: 20_000 });

    // The dialog mounts one `<Switch>` for `type="file"` (the `canUpload` switch only renders for
    // `type="collection"`) - `allowRegister`, matched by its own label rather than position.
    const toggleLabel = page.locator("label.switch", { hasText: "Let the recipient turn this into their own account" });
    const toggle = toggleLabel.locator('input[type="checkbox"]');
    await expect(toggle).toBeAttached({ timeout: 20_000 });

    // Defaults ON (D-198), and the consequence line is absent while it is.
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Everyone who opens this link shares one identity")).toHaveCount(0);

    // The real contract under test: a real click on the real, deployed-stylesheet element must reach React
    // state and render the D-23 consequence line legibly. Clicking the LABEL, not the input directly - a
    // real Switch visually hides the native checkbox under `.switch-visual` (a real user's pointer always
    // lands on the visual, never the input itself), and Playwright's actionability check correctly refuses
    // to click a target another element visually intercepts.
    await toggleLabel.click();
    const consequence = page.getByText("Everyone who opens this link shares one identity");
    await expect(consequence).toBeVisible({ timeout: 10_000 });

    // D-23 requires this text to be LEGIBLE at the point of choice, not merely present - and "present but
    // clipped mid-word" is exactly how it shipped (review session 049, found in the D-79 screenshots: the
    // invite block was a grid item at its default `min-width: auto`, so it outgrew the modal and the line
    // rendered as "The link dies aft"). `scripts/visual-check.mjs`'s own overflow guard is blind to this,
    // because it compares the DOCUMENT's scrollWidth to its clientWidth and a <dialog> clips its own
    // content without widening the page. So the assertion has to be on the element itself.
    const clipped = await consequence.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, "D-23's consequence line must wrap, never clip").toBe(false);

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(", ")}`).toEqual([]);
  });

  // E7-QA2 §C1 (D-203..D-208), updated E7.5 (D-212): <Slider> is now a real @mosni/react component, not a
  // wrapped custom element - `web/test/unit/ShareDialog.test.tsx` already drives its real `<input
  // type="range">` and real `change` events in jsdom, faithfully (no fixture stands in for anything). This
  // test stays as the one tier that opens the dialog against the ACTUAL deployed stylesheet
  // (ui.mosni.dev/mosnicat.js), which is what proves the readout renders legibly under the real CSS rather
  // than merely in jsdom's absence of layout.
  test("the invite duration slider is a real <Slider> and a click reaches React state, against the real deployed stylesheet (D-207)", async ({
    page,
    request,
  }) => {
    const sub = `user:e2e-slider-${randomUUID()}`;
    const token = await mintToken(request, sub);
    const name = `slider-ui-${randomUUID().slice(0, 8)}.txt`;
    await withDb((conn) => seedPrivateFile(conn, { name, ownerSub: sub }));

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // ONLY sdk.js is blocked - mosnicat.js must load for real, which is the entire point.
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
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Review 060/ADD-1: this file's own row, not `.first()` - see the note in the first test above.
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "Share" }).click();
    await expect(page.getByText("Add people")).toBeVisible({ timeout: 20_000 });

    const shareModal = page
      .locator("dialog.modal")
      // Review 060/ADD-1: scoped to THIS file's heading, not just /^Share/. The comment above is right
      // that a bare `dialog.modal` is a strict-mode violation - but so is a Share-only filter now that
      // the landing page opens on Browse, because EVERY listed row mounts its own Share modal. The
      // filename is what makes it one element again.
      .filter({ has: page.locator(".modal-heading", { hasText: `Share "${name}"` }) });
    const rangeInput = shareModal.locator('input[type="range"]');
    // C1.1: the internal range input is built by <Slider>'s own render, so this is real DOM regardless of
    // mosnicat.js - what genuinely depends on the real stylesheet is the readout's legibility, below.
    await expect(rangeInput).toBeAttached({ timeout: 20_000 });

    // C1.2: D-205's default, through the real element.
    const readout = shareModal.locator(".slider-readout");
    await expect(readout).toHaveText("1 hour");
    await expect(page.getByText("This link expires after 1 hour.")).toBeVisible();

    // C1.3, the real contract under test: drive it the way a user does (a focused native range input's
    // arrow keys), never page.evaluate setting the attribute directly - that would reproduce the unit
    // tier's own approach at a higher tier and prove nothing new. web/test/unit/ShareDialog.test.tsx
    // already proves the onChange wiring in jsdom; what only this tier can prove is that a real keyboard
    // interaction against the real deployed CSS produces the same result.
    await rangeInput.focus();
    // Index 1 ("1 hour") -> index 4 ("12 hours"): three presses.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(readout).toHaveText("12 hours");
    await expect(page.getByText("This link expires after 12 hours.")).toBeVisible();
    await expect(page.getByText("This link expires after 1 hour.")).toHaveCount(0);

    // C1.4: the readout must not clip. E7.5: the dialog no longer inherits white-space: nowrap from its
    // row <td> (review 049, defect 5) - <Modal> portals to document.body now, escaping that ancestor
    // entirely (CHROME-MODAL-INHERITS-NOWRAP is closed) - but the document-level overflow guard is still
    // blind to clipping inside a <dialog>, so the assertion stays as a direct check on the element itself.
    const clipped = await readout.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, "the slider readout must wrap, never clip").toBe(false);

    // C1.5.
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(", ")}`).toEqual([]);
  });
});
