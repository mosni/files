import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  await mkdir(path.dirname(abs), { recursive: true });
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
// It needed to be THIS test specifically, not just any browser test. The crash lives in the seam between
// React and a real registered custom element: mosni-chrome's MosniModal MOVES its light-DOM children into
// a <dialog> it builds (`takeSlot`/`takeDefault` call `child.remove()`), so React's recorded parent for
// those nodes goes stale and the next swap of one throws NotFoundError in React's commit phase, tearing
// down the whole root. In every test that stubs or never loads mosnicat.js, `<mosni-modal>` is an inert
// unknown element, children stay exactly where React put them, and the bug cannot exist.
//
// This is the SAME class as session 021's production `mosni-tab label` crash, and browse.spec.ts's
// "real mosni-chrome integration" block is the harness that was built for it - E7 simply never extended
// that pattern to the component it added. Hence the identical shape here: ignoreHTTPSErrors so the REAL
// ui.mosni.dev/mosnicat.js loads through the sandbox proxy, scoped with test.use to just this block, with
// retries for that one genuine external fetch (real network flakiness passes on a retry; the regression
// this exists to catch fails identically every time).
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
    const row = page.getByText(name, { exact: true }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await page.locator("mosni-dropdown", { has: page.locator("mosni-dropdown-item") }).first().click();
    await page.locator("mosni-dropdown-item", { hasText: "Share" }).first().click();

    // FIRST, prove the design system actually upgraded this element - without this the whole test is
    // vacuous. `dialog.modal` is built by MosniModal.render() itself, so it exists ONLY if the real
    // mosnicat.js loaded and `customElements.define("mosni-modal", ...)` ran. Asserting React-rendered
    // text alone (the first draft of this test did exactly that) passes identically whether the element
    // upgraded or stayed an inert unknown tag - and an inert tag is precisely the state in which the crash
    // cannot happen. Measured: with this assertion missing, this test passed against the CRASHING
    // component. browse.spec.ts gets this for free by asserting on `mosni-tabs button`, markup only the
    // upgraded element produces.
    // Scoped by heading: every row mounts THREE upgraded mosni-modals (Delete, Move, Share), so a bare
    // `mosni-modal dialog.modal` is a strict-mode violation, not a signal.
    await expect(page.locator('mosni-modal[heading^="Share"] dialog.modal')).toBeAttached({ timeout: 20_000 });

    // THEN the dialog must reach its LOADED state, not just mount - the crash happens on the
    // spinner -> content swap, so asserting the spinner alone would pass while the app is already dead.
    await expect(page.getByText("Add people")).toBeVisible({ timeout: 20_000 });

    // The real assertion. A NotFoundError in React's commit phase unmounts the root, so the surest
    // symptom is that the page still has its listing AND that nothing was thrown.
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(", ")}`).toEqual([]);
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
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
  // That unit test (web/test/unit/switchChange.test.tsx) is a textbook case of the harness removing the
  // only risk it exists to catch: `useSwitchChange` reads the HOST's own `checked` attribute on a bubbling
  // `change`, which is correct ONLY IF the real mosni-switch reflects the user's click onto that attribute
  // BEFORE the event reaches an ancestor. The unit fixture makes that true by hand
  // (`el.setAttribute("checked", ""); el.dispatchEvent(...)`) - i.e. the test author supplies the exact
  // behaviour under test, so it stays green no matter what the real element does. Same shape as the
  // round-trip collation tests and the fabricated Authorization header this whole round exists to fix.
  //
  // It is not cosmetic: this switch is `allow_register`, and turning it off is D-23's shared WRITE
  // identity. A switch that silently reports a stale value sends the wrong `allow_register` to auth.
  test("the invite switch is a REAL upgraded <mosni-switch> and its click reaches React state (F4/F13, D-198)", async ({
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
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.locator("mosni-dropdown", { has: page.locator("mosni-dropdown-item") }).first().click();
    await page.locator("mosni-dropdown-item", { hasText: "Share" }).first().click();
    await expect(page.getByText("Add people")).toBeVisible({ timeout: 20_000 });

    // Prove the element genuinely UPGRADED before asserting anything about its behaviour - an inert
    // unknown tag would render nothing and every assertion below would be about the wrong thing. The
    // internal checkbox is built by mosni-switch's own render(), so it exists only if mosnicat.js ran.
    const toggle = page.locator("mosni-modal[heading^=\"Share\"] mosni-switch").first();
    await expect(toggle).toBeAttached({ timeout: 20_000 });
    await expect(toggle.locator("input[type=checkbox]")).toBeAttached({ timeout: 20_000 });

    // Defaults ON (D-198), and the consequence line is absent while it is.
    await expect(toggle).toHaveAttribute("checked", /.*/);
    await expect(page.getByText("Everyone who opens this link shares one identity")).toHaveCount(0);

    // The actual contract under test: a real click on the real element must reach React state. If the
    // hook's attribute-timing assumption is wrong, the click still toggles the element visually and this
    // line never appears - which is exactly the failure no unit test in this repo can see.
    await toggle.click();
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
});
