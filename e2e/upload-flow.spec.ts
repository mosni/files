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
// files-e2e.test now resolves to the REAL nginx.conf in front of the app (nginx-e2e in the compose file),
// so these flows traverse the deployed topology - location precedence, client_max_body_size, buffering,
// the X-Forwarded-* headers - instead of hitting the container directly. That is what would have caught
// the two production bugs (http:// Location, and a 413 on every chunk) before they reached the box.
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `http://${FILES_HOST}`;
// app-direct.test reaches the container WITHOUT nginx, for the one assertion that must control the
// X-Forwarded-* headers itself (the sandbox's nginx has no TLS, so its $scheme is http and it cannot
// stand in for production's https-terminating proxy).
const APP_DIRECT_ORIGIN = "http://app-direct.test";
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

  // --- create (through real nginx) ----------------------------------------------------------------
  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
    },
  });
  expect(create.status(), "authorized create must be accepted").toBe(201);

  const location = create.headers()["location"];
  expect(location, "tus must return a Location").toBeTruthy();

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

  // --- the direct link really delivers the bytes, through nginx's X-Accel-Redirect ----------------
  // This goes through the REAL dl. vhost (dl.mosni.dev now resolves to nginx-e2e), so it exercises the
  // whole D-5 path end to end: the app authorizes and returns an empty body with X-Accel-Redirect, and
  // NGINX serves the actual bytes from the internal-only location. Nothing had ever tested that nginx
  // serves what the app redirects to - only that the app set the header.
  const direct = await request.get(`http://dl.mosni.dev/${relPath}`);
  expect(direct.status()).toBe(200);
  expect(Buffer.from(await direct.body()).equals(body), "nginx must deliver the exact bytes").toBeTruthy();
  expect(direct.headers()["x-content-type-options"]).toBe("nosniff");
  expect(direct.headers()["referrer-policy"]).toBe("no-referrer");
});

test("an upload larger than nginx's default body limit succeeds (the 413 regression Hannah hit)", async ({
  request,
}) => {
  // 2 MB in one PATCH - above nginx's DEFAULT client_max_body_size of 1m, below our chunk size, so a real
  // client sends it as a single body. On the box this 413'd on every chunk until nginx.conf set the limit.
  // Goes through real nginx precisely so that this assertion means something.
  const token = await mintToken(request, `user:e2e-${randomUUID()}`);
  const filename = `big-${randomUUID().slice(0, 8)}.bin`;
  const body = Buffer.alloc(2 * 1024 * 1024, 0x61);

  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
    },
  });
  expect(create.status()).toBe(201);

  const patch = await request.patch(
    `${FILES_ORIGIN}${new URL(create.headers()["location"], FILES_ORIGIN).pathname}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      data: body,
    },
  );
  expect(patch.status(), "a >1MB chunk must not be rejected by nginx").toBe(200);
});

test("behind a TLS-terminating proxy tus builds an https:// Location, never http:// (D-76 regression)", async ({
  request,
}) => {
  // The one case that must set the X-Forwarded-* headers itself: the sandbox's nginx has no TLS, so its
  // $scheme is http and it cannot stand in for production's https-terminating proxy. So hit the app
  // DIRECTLY and send exactly what production nginx sends. Without respectForwardedHeaders the app builds
  // the Location from the raw request and returns http://, which an https page's CSP blocks - the bug
  // masked by helmet's upgrade-insecure-requests until D-76 removed it.
  const token = await mintToken(request, `user:e2e-${randomUUID()}`);
  const create = await request.post(`${APP_DIRECT_ORIGIN}/api/upload`, {
    headers: {
      host: FILES_HOST,
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": "5",
      "upload-metadata": `filename ${b64("scheme.txt")}`,
      "x-forwarded-proto": "https",
      "x-forwarded-host": FILES_HOST,
    },
  });
  expect(create.status()).toBe(201);
  expect(create.headers()["location"]).toMatch(/^https:\/\//);
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
