import { expect, test } from "@playwright/test";

// E2+E5a (Wave G2), against the real production image (`app-e2e`).
//
// What this file does NOT cover, and why: G2's full list ("upload a file, assert progress reaches 100%,
// assert the returned link fetches back the same bytes, assert click-to-copy writes to the clipboard")
// needs a real, authorized `files:write` Bearer token. Minting one requires a live auth.mosni.dev issuing
// a JWT this app's verify() can check against auth's real JWKS - and auth.mosni.dev is not reachable from
// this sandbox (no live IdP, same category of limitation as D-43's bot-core check). That flow is on the
// manual-check list (verification-concept.md) until it can be walked against a real deploy or a stood-up
// mock IdP - flagging rather than faking it.
//
// What this DOES verify against the real running app: the parts of the tus/delivery contract that don't
// require a successful login, which is still real coverage of the production image's actual behaviour.

// app-e2e's APP_ORIGIN in this compose tier (see docker-compose.verify.yml). BASE_URL is `http://app-e2e`,
// i.e. the container's own name, so any host-constrained route needs this Host header spelled out - the
// same way the dl. tests below spell out `dl.mosni.dev`.
const FILES_HOST = "files-e2e.test";

test("tus upload is rejected with no bearer token (real production image, D1)", async ({ request }) => {
  const res = await request.post("/api/upload", {
    headers: {
      host: FILES_HOST,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": "5",
      "Upload-Metadata": `filename ${Buffer.from("x.txt").toString("base64")}`,
    },
  });
  expect(res.status()).toBe(401);
});

// The containment origin (D-4/D-33) must carry no app surface but delivery. Guarded in the integration
// tier too (server-routing.test.ts); asserted here against the real production image as well, because
// this is the tier that exercises the actual shipped route table.
test("the upload API is not reachable on the dl host (real production image, D-33)", async ({ request }) => {
  const res = await request.post("/api/upload", {
    headers: { host: "dl.mosni.dev", "Tus-Resumable": "1.0.0", "Upload-Length": "5" },
  });
  expect(res.status()).toBe(404);
});

test("plain-path delivery 404s for a path with no row (real production image)", async ({ request }) => {
  const res = await request.get("/nobody/here/nope.txt", {
    // dl.mosni.dev's host-constrained /* route - app-e2e has no real dl. vhost in this compose network,
    // so this hits the same process directly and relies on the Host header, exactly as nginx's proxy_pass
    // would forward it in production.
    headers: { host: "dl.mosni.dev" },
  });
  expect(res.status()).toBe(404);
});

test("token delivery 404s for an unknown token (real production image)", async ({ request }) => {
  const res = await request.get("/t/ZZZZZ", { headers: { host: "dl.mosni.dev" } });
  expect(res.status()).toBe(404);
});
