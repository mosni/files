import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ensureSharedDir } from "./seedStorage.ts";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// E4 Wave E2: the file browser (Wave D) driven through a real browser. Fixtures are seeded directly, the
// same way e2e/preview.spec.ts and e2e/upload-flow.spec.ts do - there is no live IdP here for a real
// upload, and mysql2 writes straight into the shared MariaDB the app container reads from. A signed-in
// scenario mints a real token from e2e/mock-idp.mjs so the app's own unmodified verify() accepts it,
// exactly like upload-flow.spec.ts's authenticated flow.
const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";
// files-e2e.test, not files.mosni.dev - see preview.spec.ts's long comment: mosni.dev is HSTS-preloaded in
// Chromium, so a plain http:// navigation to it silently upgrades to https:// and fails in this sandbox.
const FILES_HOST = "files-e2e.test";
// E5.1 Wave H (D-162): https, not http - nginx-e2e now terminates real TLS for this tier.
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

async function seedCollection(
  conn: mysql.Connection,
  opts: { name: string; ownerSub: string; protection?: "public" | "unlisted" | "secret" | "private" },
): Promise<{ id: string; linkToken: string }> {
  const id = newId();
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    "INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token) VALUES (?, '', ?, ?, ?, ?, ?)",
    [id, opts.name, opts.ownerSub, opts.protection ?? "unlisted", opts.protection ?? "unlisted", linkToken],
  );
  return { id, linkToken };
}

async function seedFile(
  conn: mysql.Connection,
  opts: { collectionId: string; name: string; ownerSub: string; protection?: "public" | "unlisted" | "secret" | "private" },
): Promise<{ id: string; linkToken: string }> {
  const id = newId();
  const diskDir = "2026/07";
  const diskName = `${id}-${opts.name}`;
  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  // Review 060/SEC-2: shared-writable - app-e2e writes this same directory. See e2e/seedStorage.ts.
  await ensureSharedDir(path.dirname(abs));
  await writeFile(abs, "browse e2e fixture bytes");
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    `INSERT INTO files (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub)
     VALUES (?, ?, ?, ?, ?, 24, ?, ?, 'committed', ?)`,
    [id, opts.collectionId, opts.name, diskDir, diskName, opts.protection ?? "public", linkToken, opts.ownerSub],
  );
  return { id, linkToken };
}

test("anonymous browse (D-94): a published collection is shown, an unpublished one is not", async ({ page }) => {
  const run = randomUUID().slice(0, 8);
  const published = await withDb((conn) =>
    seedCollection(conn, { name: `pub-${run}`, ownerSub: "user:e2e-browse", protection: "public" }),
  );
  await withDb((conn) => seedFile(conn, { collectionId: published.id, name: "published.txt", ownerSub: "user:e2e-browse" }));
  const unpublished = await withDb((conn) =>
    seedCollection(conn, { name: `unpub-${run}`, ownerSub: "user:e2e-browse", protection: "unlisted" }),
  );
  await withDb((conn) => seedFile(conn, { collectionId: unpublished.id, name: "hidden.txt", ownerSub: "user:e2e-browse" }));

  // Both DropZone and FileBrowser poll for `window.mosni` before deciding what to render, and the real
  // auth SDK is unreachable in this sandbox network (no live auth.mosni.dev/TLS trust) - even "anonymous"
  // needs the same sdk.js-block + stub every authenticated e2e test already uses, just with a null user,
  // or the poll never resolves and the page never leaves its loading spinner.
  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(`
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => null,
      token: () => null,
      onChange: (cb) => cb(null),
      login: () => {}, logout: () => {},
      toast: () => {},
    });
  `);

  await page.goto(`${FILES_ORIGIN}/`);

  // E4.1 Wave E findings (C4/D-121): a collection's name is a real <a href>, not a <button> - only a
  // real anchor supports copy-link-address/open-in-new-tab/refresh.
  await expect(page.getByRole("link", { name: `pub-${run}` })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: `unpub-${run}` })).toHaveCount(0);
});

test("a signed-in owner's \"My files\" tab shows their own collection and file", async ({ page, request }) => {
  const sub = `user:e2e-browse-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const run = randomUUID().slice(0, 8);
  const mine = await withDb((conn) => seedCollection(conn, { name: `mine-${run}`, ownerSub: sub }));
  await withDb((conn) => seedFile(conn, { collectionId: mine.id, name: "my-file.txt", ownerSub: sub, protection: "unlisted" }));

  // Only the auth SDK is stubbed (it needs a live auth.mosni.dev) - the token is real and the server
  // verifies it for real, same pattern as e2e/upload-flow.spec.ts's authenticated browser test.
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

  // D-80: the pseudo-root never holds files directly - the file only appears once drilled into its
  // collection (breadcrumb drill-down, D-102).
  const collectionButton = page.getByRole("link", { name: `mine-${run}` });
  await expect(collectionButton).toBeVisible({ timeout: 10_000 });
  await collectionButton.click();
  // Scoped to a real link, not a bare getByText(): Wave A2 (D-8, session 036) made the Delete AND Move
  // modals for this row always render their heading ("Delete/Move \"my-file.txt\"...") regardless of
  // `open`, so an unscoped substring match against "my-file.txt" resolves to 3 elements (the row's own
  // link plus both modal headings) and throws in strict mode. Fix the query, not the component - exactly
  // the rule that fix's own hand-off states.
  await expect(page.getByRole("link", { name: "my-file.txt" })).toBeVisible({ timeout: 10_000 });
});

test("the link offered for a file gated only by its collection contains no collection name (D-100)", async ({
  page,
  request,
}) => {
  const sub = `user:e2e-browse-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const run = randomUUID().slice(0, 8);
  // The collection is `secret`; the file inside is stored `public` - its EFFECTIVE level is `secret`
  // (D-96). `private` still resolves at its readable path (D-99 - only asks who you are); `secret` is the
  // one level whose readable path never resolves for anyone, so it's the one D-100's token-only rule
  // actually applies to.
  const gate = await withDb((conn) =>
    seedCollection(conn, { name: `gate-${run}`, ownerSub: sub, protection: "secret" }),
  );
  const file = await withDb((conn) =>
    seedFile(conn, { collectionId: gate.id, name: "gated.txt", ownerSub: sub, protection: "public" }),
  );

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
  // D-80: drill into the gating collection first - the pseudo-root never lists files directly.
  const collectionButton = page.getByRole("link", { name: `gate-${run}` });
  await expect(collectionButton).toBeVisible({ timeout: 10_000 });
  await collectionButton.click();
  // Scoped to a real link, not a bare getByText() - see the sibling test above's comment (D-8/session 036,
  // Wave A2's always-rendered Delete/Move modal headings also match "gated.txt" as a substring).
  await expect(page.getByRole("link", { name: "gated.txt" })).toBeVisible({ timeout: 10_000 });

  // D-100: the owner deliberately navigated into the gating collection (its name in the breadcrumb is
  // expected - they already know where they are), but the SHARE LINK this row hands out must still be
  // the token form, never a /f/<collection>/<name> path that would leak the collection to whoever
  // receives the link. E4.1 Wave B replaced the always-visible copy-field input with the row's own name
  // link (`previewUrl` verbatim, D-100/D-96) and a "Copy link" item in the trailing overflow menu that
  // copies the same URL - checking the row's own href is the more direct assertion of the two.
  const fileLink = page.getByRole("link", { name: "gated.txt" });
  await expect(fileLink).toHaveAttribute("href", new RegExp(`/t/${file.linkToken}$`));
});

// PRODUCTION INCIDENT, 2026-07-29: FileBrowser's mosni-tabs switcher crashed the ENTIRE page in production
// ("Uncaught TypeError: setting getter-only property 'label'") the moment a signed-in user (2+ tabs)
// loaded "/". This was the D-8 class of hazard - a custom element's real registered class fighting React
// over a property - and it is why this block exists at all.
//
// E7.5 (D-212/D-214): FileBrowser's tabs are now `<Tabs>`/`<Tab>` (@mosni/react), real components that
// render a real `<button role="tab">` DOM directly - there is no custom element here any more for
// mosnicat.js to upgrade, and the class of crash this test was built for cannot recur at this call site.
// The block stays anyway: it is now the guard that this page loads against the REAL deployed stylesheet
// (ui.mosni.dev/mosnicat.js, not a stub) with zero uncaught page errors, which is still worth having and
// is cheap. `ignoreHTTPSErrors` is what makes the real script load through this sandbox's outbound proxy,
// scoped to just this file via `test.use` below rather than the whole suite, since no other test here
// needs it.
test.describe("real mosni-chrome integration (must load the ACTUAL mosnicat.js/auth SDK, not a stub of them)", () => {
  test.use({ ignoreHTTPSErrors: true });
  // This is the one test in the whole suite that depends on a genuine external fetch (ui.mosni.dev)
  // through the sandbox's own outbound proxy, rather than purely local/mocked network calls - under
  // parallel workers it occasionally loses the race against other tests for that fetch. A retry is the
  // right tool for that: real network flakiness passes on a retry, but an actual regression (the crash
  // this test exists to catch) fails identically every time regardless of how many retries it gets.
  test.describe.configure({ retries: 2 });

  test("the tab switcher renders and is clickable with zero uncaught page errors", async ({ page, request }) => {
    const sub = `user:e2e-browse-${randomUUID()}`;
    const token = await mintToken(request, sub);
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // Only sdk.js is blocked (it needs a live auth.mosni.dev to do anything useful, same as every other
    // authenticated test in this suite) - mosnicat.js is left to load for REAL, which is the entire point.
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
    // A signed-in user without the admin role sees exactly two tabs ("My files", "Browse") - the case
    // that crashed in production, since visibleTabs.length > 1 is what renders <Tabs> at all.
    await expect(page.getByRole("tab", { name: "My files" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("tab", { name: "Browse" })).toBeVisible();
    await page.getByRole("tab", { name: "Browse" }).click();
    await page.waitForTimeout(300);

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(", ")}`).toEqual([]);
  });

  // ⚠ Added by review session 055. E7.5 Wave E (D-213) moved the header out of index.html's static <body>
  // and into main.tsx's React tree, which gave main.tsx a second load-bearing guarantee: <Header> renders
  // as a SIBLING before the width-capped <main>, never inside it. main.tsx's own comment names the failure
  // ("or it renders capped and centred instead of full-width"), and nothing enforced it - main.tsx is
  // excluded from coverage as untestable mount glue and is imported by no test, so the only evidence was a
  // screenshot a human had to look at. This tier renders the real built SPA, so the structure is readable
  // directly, and it fails on a header nested one level too deep - which a screenshot only catches if
  // somebody notices the width.
  test("the header renders in the React tree as a sibling of <main>, never nested inside it (D-213)", async ({
    page,
    request,
  }) => {
    const sub = `user:e2e-header-structure-${randomUUID()}`;
    const token = await mintToken(request, sub);

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
    // Wait for the React root, not the header - the header IS the thing under test, so waiting on it
    // would turn "it never rendered at all" into a timeout in the wrong place.
    await expect(page.getByRole("tab", { name: "My files" })).toBeVisible({ timeout: 20_000 });

    await expect(page.locator("header.header")).toHaveCount(1);
    await expect(page.locator("main header.header"), "the header must not be inside the width-capped <main>").toHaveCount(0);
    // ...and it is React's, not a leftover static tag in the shipped index.html (E1).
    await expect(page.locator("mosni-header")).toHaveCount(0);
  });
});
