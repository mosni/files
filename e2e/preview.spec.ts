import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// D-70 Wave D. Uploading is not reachable without a live IdP (same limitation
// upload-delivery.spec.ts documents), so fixtures are seeded directly: write the bytes at the exact path
// app-e2e will stat() - shared via the `e2e-storage` volume in docker-compose.verify.yml - and insert the
// matching row straight into the real mariadb service both containers share.
const STORAGE_ROOT = "/data/storage";
// `files-e2e.test`, NOT the real `files.mosni.dev` (docker-compose.verify.yml's app-e2e APP_ORIGIN for
// this tier only): `mosni.dev` is on Chromium's baked-in HSTS preload list, so a real browser silently
// upgrades any `http://files.mosni.dev/...` navigation to https:// and gets ERR_CONNECTION_REFUSED against
// this sandbox's plain-HTTP-only app-e2e (confirmed empirically - not fixable via any test-side config,
// since it's a policy baked into the Chromium binary itself). `.test` is IANA-reserved for testing
// (RFC 2606) and can never be preload-listed. `files-e2e.test` is a real DNS alias for this container on
// the compose network, so a real browser can navigate a genuine host-constrained route directly - no
// header spoofing needed (which Chromium separately rejects for real page navigations at every layer
// tried: browser.newContext's extraHTTPHeaders throws net::ERR_INVALID_ARGUMENT; page.route()'s CDP-level
// header rewrite is silently dropped for the main-frame navigation request specifically). app-e2e listens
// on port 80 in this compose tier specifically so the browser's Host header omits the port (Fastify's
// `constraints: { host }` is an exact string match against the bare hostname) - mirroring how production
// omits 443 for HTTPS.
const FILES_HOST = "files-e2e.test";
const FILES_ORIGIN = `http://${FILES_HOST}`;

async function seed(opts: {
  relPath: string;
  protection?: "public" | "unlisted" | "secret" | "private";
  width?: number;
  height?: number;
}): Promise<{ linkToken: string }> {
  const linkToken = randomUUID().replace(/-/g, "").slice(0, 5);
  const abs = path.join(STORAGE_ROOT, ...opts.relPath.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "e2e preview fixture bytes");

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "mariadb",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "files",
    password: process.env.DB_PASS ?? "filespass",
    database: process.env.DB_NAME ?? "files",
  });
  try {
    await conn.execute(
      "INSERT INTO files (path, bytes, protection, link_token, width, height) VALUES (?, ?, ?, ?, ?, ?)",
      [opts.relPath, 25, opts.protection ?? "public", linkToken, opts.width ?? null, opts.height ?? null],
    );
  } finally {
    await conn.end();
  }
  return { linkToken };
}

test("crawler simulation: the raw HTML carries OG/Twitter/oEmbed/JSON-LD tags with no JavaScript", async ({
  request,
}) => {
  const relPath = `e2e-crawler-${randomUUID()}/photo.png`;
  await seed({ relPath, width: 640, height: 480 });

  // request.get() is Playwright's plain HTTP API context - no browser, no JS execution. This is the
  // automated stand-in for "does it unfurl", and the whole reason the head is server-rendered at all.
  const res = await request.get(`/f/${relPath}`, { headers: { host: FILES_HOST } });
  expect(res.status()).toBe(200);
  const body = await res.text();

  expect(body).toContain('property="og:title" content="photo.png"');
  expect(body).toContain('property="og:image"');
  expect(body).toContain('property="og:image:width" content="640"');
  expect(body).toContain('name="twitter:card" content="summary_large_image"');
  expect(body).toContain('rel="canonical"');
  expect(body).toContain("application/json+oembed");
  expect(body).toContain("application/ld+json");
});

test("browser: the SPA mounts and paints the file name and copy fields from the embedded context", async ({
  page,
}) => {
  const relPath = `e2e-browser-${randomUUID()}/photo.png`;
  await seed({ relPath, width: 640, height: 480 });

  await page.goto(`${FILES_ORIGIN}/f/${relPath}`);

  await expect(page.locator("h1")).toHaveText("photo.png");
  await expect(page.locator(".copy-field-primary input")).toHaveValue(
    `https://${FILES_HOST}/f/${relPath}`,
  );
});

test("no CSP violation is raised loading a PDF preview (guards Wave C5's frame-src fix)", async ({
  page,
}) => {
  const relPath = `e2e-pdf-${randomUUID()}/doc.pdf`;
  await seed({ relPath });

  // Scoped to frame-src/frame-ancestors specifically (Wave C5's fix and its frame-ancestors reciprocal),
  // not "any CSP notice on the page" - mosnicat.js (the design-system chrome, loaded unconditionally and
  // out of this pass's scope) separately tries to load a favicon-ish image from the bare mosni.dev domain
  // and gets blocked by img-src, which is real but unrelated pre-existing noise this test must not trip on.
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      /Content Security Policy/i.test(msg.text()) &&
      /frame-src|frame-ancestors|Framing/i.test(msg.text())
    ) {
      cspViolations.push(msg.text());
    }
  });

  await page.goto(`${FILES_ORIGIN}/f/${relPath}`);
  // The iframe points at https://dl.mosni.dev, unreachable from this sandbox network (no TLS listener) -
  // the point of this test is only that the CSP directive permits the attempt at all (Wave C5's fix), not
  // that it succeeds.
  await page.locator("iframe").waitFor({ state: "attached" });
  await page.waitForTimeout(500);

  expect(cspViolations).toEqual([]);
});
