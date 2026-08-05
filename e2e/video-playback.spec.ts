import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// D-167 (E5.1 live-testing round 2, reported TWICE - see VideoPreview.tsx's header comment for the full
// root cause): a REAL video, decoded by a REAL browser, through the REAL delivery pipeline - closing the
// exact gap that let a genuine regression ship, get "fixed", and ship broken again under a fully green
// suite. Every other video test in this repo mocks either `@vidstack/react` (VideoPreview.readiness.
// test.ts) or the whole player (VideoPreview.test.tsx asserts DOM shape only), because jsdom has no real
// media pipeline - `canplay`/`loadeddata` cannot be dispatched into it. That is a legitimate reason to
// unit-test VideoPreview's OWN state machine against a mock, but it is NOT a reason the suite never
// verified Vidstack actually SELECTS A PROVIDER and DECODES anything - which is exactly what broke twice,
// invisibly, because every existing test asserts VideoPreview's reaction to an ASSUMED outcome, never
// whether Vidstack (a third-party black box to this codebase) actually produces that outcome.
//
// `e2e/fixtures/clip.webm` - VP9, not H.264/mp4 - deliberately: Playwright's bundled Chromium is the
// open-source build and has NO H.264 decoder at all (confirmed empirically: the identical harness against
// an H.264 `clip.mp4` fails every time with a real, distinct MediaError - `DEMUXER_ERROR_NO_SUPPORTED_
// STREAMS`, code 4 - regardless of any code change here; a REAL Chrome/Firefox/Safari has no such gap).
// VP9 is patent-unencumbered and always decodable in vanilla Chromium, so this isolates the thing this
// test actually needs to verify - provider SELECTION and decode wiring - from an unrelated, pre-existing
// sandbox/tooling limitation (the same class as §D4's H.264-vs-HEVC discriminator, already flagged
// box-only in the E5.1 hand-off). Generated via
// `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -c:v libvpx-vp9 -pix_fmt yuv420p`; tiny
// enough (7.8KB) to commit, real enough that the browser's actual decoder has to do actual work.
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "clip.webm");

const IDP = process.env.MOCK_IDP ?? "http://mock-idp:9000";
const FILES_HOST = "files-e2e.test";
// E5.1 Wave H (D-162): https, not http - nginx-e2e now terminates real TLS (self-signed,
// `ignoreHTTPSErrors: true` in playwright.config.ts), which is the whole reason these two tests below are
// no longer test.skip()'d - see their own updated header comment.
const FILES_ORIGIN = `https://${FILES_HOST}`;

async function mintToken(request: import("@playwright/test").APIRequestContext, sub: string) {
  const res = await request.get(`${IDP}/token?sub=${encodeURIComponent(sub)}&roles=files:write`);
  expect(res.ok(), "mock-idp must mint a token").toBeTruthy();
  return (await res.json()).token as string;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

async function uploadClip(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  filename: string,
): Promise<{ previewUrl: string; directUrl: string }> {
  const body = await readFile(FIXTURE_PATH);
  const create = await request.post(`${FILES_ORIGIN}/api/upload`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(body.length),
      "upload-metadata": `filename ${b64(filename)}`,
    },
  });
  expect(create.status()).toBe(201);
  const uploadUrl = new URL(create.headers()["location"], FILES_ORIGIN);
  const patch = await request.patch(`${FILES_ORIGIN}${uploadUrl.pathname}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    data: body,
  });
  expect(patch.status()).toBe(200);
  return (await patch.json()) as { previewUrl: string; directUrl: string };
}

// The completion response (buildFileUrls, controllers/upload.ts) carries only previewUrl/directUrl, never
// the surrogate id (D-81 - the client is never handed a bare id to address a file by) - so switching a
// freshly-uploaded file's protection needs it looked up the same way upload-flow.spec.ts's own DB
// assertions already do, by its unique display NAME.
async function idByName(filename: string): Promise<string> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  try {
    const [rows] = await conn.execute("SELECT id FROM files WHERE name = ?", [filename]);
    const row = (rows as { id: string }[])[0];
    expect(row, "the uploaded file's row must exist").toBeTruthy();
    return row!.id;
  } finally {
    await conn.end();
  }
}

// Signs the browser in as the file's owner via the same window.mosni stub the "three-action path" e2e
// test already uses - the token is real and the server verifies it for real, only the auth SDK is stubbed
// (it needs a live auth.mosni.dev to load at all, unreachable from this sandbox).
async function signInAsOwner(page: import("@playwright/test").Page, sub: string, token: string) {
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
}

// The real assertion D-167 needed and never had: not "a <media-player> element exists" (that only proves
// VideoPreview rendered SOMETHING, which it did even while completely broken - finding 5 shipped with
// exactly that DOM present) but that the underlying <video> Vidstack actually created has REAL
// browser-decoded media behind it. `readyState >= 2` (HAVE_CURRENT_DATA) means the browser has decoded at
// least the current frame - unreachable if no provider was ever selected (D-167's exact failure, twice)
// or if playback genuinely errored.
async function expectRealPlayback(page: import("@playwright/test").Page) {
  const video = page.locator("video");
  await expect(video).toBeAttached({ timeout: 15_000 });
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByText("This video can't play in this browser.")).toHaveCount(0);
  // Round 4 (Hannah: "it could easily play in a native video element" / "renders on every video, even
  // ones the browser can play"): a player that reports ready but collapses to ~2px (missing the
  // `aspectRatio` prop Vidstack's own CSS needs to give the box real height) fails the fallback-text
  // assertion above too, since D2's own MIN_PLAYER_HEIGHT_PX check flips it to the download card - but a
  // direct height assertion pins the specific failure mode down rather than relying on that as a proxy.
  const box = await video.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(64);
}

// UNSKIPPED, E5.1 Wave H (D-162): `directUrl` is the REAL `https://dl.mosni.dev` origin (deliberately
// never rewritten to `-e2e.test`, same reason DL_ORIGIN stays real in app-e2e's own environment block
// below - server.ts's CSP hardcodes the literal string "https://dl.mosni.dev"), and until this wave
// nginx-e2e's own setup DELETED every `listen 443 ssl;` block, so nothing in this sandbox had a TLS
// listener for it (confirmed at the time: the browser got `ERR_CONNECTION_REFUSED` on port 443, not a
// decode failure) - the SAME structural gap as `E5-ARCHIVE-E2E` (service workers need a secure context;
// this needed a reachable one). nginx-e2e now builds a self-signed cert covering both `files-e2e.test` and
// `dl.mosni.dev` (its own SAN list) and Playwright's config trusts it project-wide
// (`ignoreHTTPSErrors: true`), so this is now the permanent, always-running regression guard for D-167/
// D-164 the header comment above describes. The FIX itself (VideoPreview.tsx's memoised `src={{src,
// type}}`) was independently verified before this wave too: a throwaway local harness (Vite dev server,
// real unmocked `@vidstack/react`, real Playwright/Chromium, a real WebM fixture at both a with-extension
// and an extensionless URL) reached `readyState 4`/`canplaythrough` in both shapes - see session 035's log
// for that transcript.
test("a real video, public/unlisted (plain-path directUrl, has a real extension): the player actually decodes it", async ({
  page,
  request,
}) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `clip-public-${randomUUID().slice(0, 8)}.webm`;
  const { previewUrl } = await uploadClip(request, token, filename);

  await signInAsOwner(page, sub, token);
  await page.goto(`${FILES_ORIGIN}${new URL(previewUrl).pathname}`);

  await expectRealPlayback(page);
});

// D-167's exact scenario: a `private` file's OWNER gets an EXTENSIONLESS D-84 signed URL
// (`dl.mosni.dev/s/<id>?exp=...&sig=...`) - no file extension for Vidstack's canPlay() to match, so the
// `src={{src, type}}` object form (VideoPreview.tsx) is the ONLY way it can select a provider at all. This
// is the scenario both live-testing-round-2 attempts targeted; only a real, unmocked Vidstack against a
// real URL of this exact shape can prove which one actually works.
// UNSKIPPED, E5.1 Wave H - see the sibling test's comment above; same `dl.mosni.dev` TLS gap, now closed.
test("a real video, private (extensionless signed directUrl): the player actually decodes it (D-167)", async ({
  page,
  request,
}) => {
  const sub = `user:e2e-${randomUUID()}`;
  const token = await mintToken(request, sub);
  const filename = `clip-private-${randomUUID().slice(0, 8)}.webm`;
  await uploadClip(request, token, filename);
  const id = await idByName(filename);

  const patchRes = await request.patch(`${FILES_ORIGIN}/api/files/${id}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { protection: "private" },
  });
  expect(patchRes.status(), "the owner must be able to switch their own file to private").toBe(200);
  const { previewUrl, directUrl } = (await patchRes.json()) as { previewUrl: string; directUrl: string };
  // Confirms the scenario is really the one under test, before spending a browser on it - an extensionless
  // signed URL, not a path that happens to still carry .webm.
  expect(new URL(directUrl).pathname).toMatch(/^\/s\/[^/]+$/);

  await signInAsOwner(page, sub, token);
  await page.goto(`${FILES_ORIGIN}${new URL(previewUrl).pathname}`);

  await expectRealPlayback(page);
});
