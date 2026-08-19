import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ensureSharedDir } from "./seedStorage.ts";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// E8 Wave E1: the admin panel driven through a real browser + the real production image, mirroring
// e2e/browse.spec.ts's and e2e/share.spec.ts's fixture-seeding conventions. mock-idp signs real RS256
// tokens the app's own unmodified verify() accepts, so a both-roles admin is mintable for real.
const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `https://${FILES_HOST}`;
const STORAGE_ROOT = "/data/storage";

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string, roles: string) {
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

async function seedPrivateCollection(conn: mysql.Connection, opts: { name: string; ownerSub: string }) {
  const id = newId();
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    "INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token) VALUES (?, '', ?, ?, 'private', 'private', ?)",
    [id, opts.name, opts.ownerSub, linkToken],
  );
  return { id, linkToken };
}

async function seedFile(conn: mysql.Connection, opts: { collectionId: string; name: string; ownerSub: string }) {
  const id = newId();
  const diskDir = "2026/08";
  const diskName = `${id}-${opts.name}`;
  const abs = path.join(STORAGE_ROOT, diskDir, diskName);
  // Review 060/SEC-2: shared-writable, because app-e2e writes this same directory as uid 1000.
  await ensureSharedDir(path.dirname(abs));
  await writeFile(abs, "admin e2e fixture bytes");
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  await conn.execute(
    `INSERT INTO files (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub)
     VALUES (?, ?, ?, ?, ?, 24, 'private', ?, 'committed', ?)`,
    [id, opts.collectionId, opts.name, diskDir, diskName, linkToken, opts.ownerSub],
  );
  return { id };
}

function stubSignedIn(sub: string, roles: string[], token: string) {
  return `
    window.mosni = Object.assign(window.mosni ?? {}, {
      user: () => ({ sub: ${JSON.stringify(sub)}, roles: ${JSON.stringify(roles)} }),
      token: () => ${JSON.stringify(token)},
      onChange: (cb) => cb({ sub: ${JSON.stringify(sub)}, roles: ${JSON.stringify(roles)} }),
      login: () => {}, logout: () => {},
      toast: () => {},
    });
  `;
}

test("an admin reaches /admin and sees both sections", async ({ page, request }) => {
  const sub = `user:e2e-admin-${randomUUID()}`;
  const token = await mintToken(request, sub, "files:write,files:delete");

  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(stubSignedIn(sub, ["files:write", "files:delete"], token));

  await page.goto(`${FILES_ORIGIN}/admin`);
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Access" })).toBeVisible();
});

test("a files:read-only identity gets nothing at /admin, and GET /api/admin/usage 404s (D-217)", async ({ page, request }) => {
  const sub = `user:e2e-admin-reader-${randomUUID()}`;
  const token = await mintToken(request, sub, "files:read");

  const usage = await request.get(`${FILES_ORIGIN}/api/admin/usage`, { headers: { authorization: `Bearer ${token}` } });
  expect(usage.status()).toBe(404);

  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(stubSignedIn(sub, ["files:read"], token));

  await page.goto(`${FILES_ORIGIN}/admin`);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Usage" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Access" })).toHaveCount(0);
});

test("a grant appears in the Access list and revoking it removes the grantee's access", async ({ page, request }) => {
  const run = randomUUID().slice(0, 8);
  const adminSub = `user:e2e-admin-${run}`;
  const ownerSub = `user:e2e-admin-owner-${run}`;
  const granteeSub = `user:e2e-admin-grantee-${run}`;
  const collectionName = `admin-e2e-${run}`;
  const fileName = `secret-${run}.txt`;

  const collection = await withDb((conn) => seedPrivateCollection(conn, { name: collectionName, ownerSub }));
  await withDb((conn) => seedFile(conn, { collectionId: collection.id, name: fileName, ownerSub }));
  await withDb((conn) =>
    conn.execute("INSERT INTO collection_acl (collection_id, sub, can_upload) VALUES (?, ?, 0)", [collection.id, granteeSub]),
  );

  const adminToken = await mintToken(request, adminSub, "files:write,files:delete");
  const granteeToken = await mintToken(request, granteeSub, "files:write");

  // The grantee can read the file before revoke.
  const before = await request.get(`https://dl.mosni.dev/${collectionName}/${fileName}`, {
    headers: { authorization: `Bearer ${granteeToken}` },
  });
  expect(before.status()).toBe(200);

  await page.route("**/sdk.js", (route) => route.abort());
  await page.addInitScript(stubSignedIn(adminSub, ["files:write", "files:delete"], adminToken));

  await page.goto(`${FILES_ORIGIN}/admin`);
  const row = page.locator("tr", { hasText: granteeSub });
  await expect(row).toBeVisible({ timeout: 10_000 });

  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Yes, revoke" }).click();
  await expect(row).toHaveCount(0);

  const after = await request.get(`https://dl.mosni.dev/${collectionName}/${fileName}`, {
    headers: { authorization: `Bearer ${granteeToken}` },
  });
  expect(after.status()).toBe(403);
});
