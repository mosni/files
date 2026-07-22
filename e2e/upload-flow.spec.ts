import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

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
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `http://${FILES_HOST}`;
const STORAGE_ROOT = "/data/storage";

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string, roles = "files:write") {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=${encodeURIComponent(roles)}`);
  expect(res.ok(), "mock-idp must mint a token").toBeTruthy();
  return (await res.json()).token as string;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a real authorized tus upload lands the bytes, and the returned link serves them back", async ({
  request,
}) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `upload-${randomUUID().slice(0, 8)}.txt`;
  const body = Buffer.from(`hello from the real upload flow ${randomUUID()}`);

  // --- create -------------------------------------------------------------------------------------
  // X-Forwarded-Proto/Host are what nginx sends on both vhosts in production. Sending them here is the
  // whole point of this assertion: it reproduces the bug Hannah hit on the real box, where tus built its
  // Location from the raw request, handed the browser `http://files.mosni.dev/api/upload/<id>`, and the
  // https page's CSP blocked the PATCH. It stayed hidden until D-76 removed helmet's
  // upgrade-insecure-requests, which had been silently rewriting the scheme. This tier talks to the
  // container directly over plain HTTP, so without these headers http:// is the *correct* answer and the
  // regression would be untestable here.
  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
      "x-forwarded-proto": "https",
      "x-forwarded-host": FILES_HOST,
    },
  });
  expect(create.status(), "authorized create must be accepted").toBe(201);

  const location = create.headers()["location"];
  expect(location, "tus must return a Location").toBeTruthy();
  expect(
    location,
    "behind a TLS-terminating proxy the Location must be https:// - an http:// one is blocked by the CSP",
  ).toMatch(/^https:\/\//);

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

  // --- the bytes are really on disk, unchanged ----------------------------------------------------
  const relPath = new URL(directUrl).pathname.replace(/^\//, "");
  const onDisk = await readFile(path.join(STORAGE_ROOT, ...relPath.split("/").map(decodeURIComponent)));
  expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
    createHash("sha256").update(body).digest("hex"),
  );

  // --- the preview link works ---------------------------------------------------------------------
  const preview = await request.get(`${FILES_ORIGIN}${new URL(previewUrl).pathname}`, {
    headers: { host: FILES_HOST },
  });
  expect(preview.status()).toBe(200);
  expect(await preview.text()).toContain(filename);

  // --- the direct link delivers via nginx, with Node never streaming (D-5) ------------------------
  const direct = await request.get(`${FILES_ORIGIN}/${relPath}`, { headers: { host: "dl.mosni.dev" } });
  expect(direct.status()).toBe(200);
  expect(direct.headers()["x-accel-redirect"], "delivery must hand off to nginx").toBeTruthy();
  expect(await direct.text(), "Node must not stream the bytes itself").toBe("");
  expect(direct.headers()["x-content-type-options"]).toBe("nosniff");
  expect(direct.headers()["referrer-policy"]).toBe("no-referrer");
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
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(body),
  });

  // The share field only appears once the upload really completed and the server returned its URLs.
  const shareInput = page.locator(".copy-field-primary input");
  await expect(shareInput).toBeVisible({ timeout: 30_000 });

  const shareUrl = await shareInput.inputValue();
  expect(shareUrl).toContain(filename);

  // And the link it just handed the user actually resolves.
  const preview = await request.get(`${FILES_ORIGIN}${new URL(shareUrl).pathname}`, {
    headers: { host: FILES_HOST },
  });
  expect(preview.status(), "the copied link must work").toBe(200);
  expect(await preview.text()).toContain(filename);
});
