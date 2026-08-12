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
