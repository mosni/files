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

test("tus upload is rejected with no bearer token (real production image, D1)", async ({ request }) => {
  const res = await request.post("/api/upload", {
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": "5",
      "Upload-Metadata": `filename ${Buffer.from("x.txt").toString("base64")}`,
    },
  });
  expect(res.status()).toBe(401);
});

test("delivery 404s for a file that does not exist (real production image)", async ({ request }) => {
  const res = await request.get("/some-nonexistent-collection/nope.txt", {
    // dl.mosni.dev's host-constrained route - app-e2e has no real dl. vhost in this compose network, so
    // this hits the same process directly and relies on the Host header, exactly as nginx's proxy_pass
    // would forward it in production.
    headers: { host: "dl.mosni.dev" },
  });
  expect(res.status()).toBe(404);
});

test("a bare single segment that is not token-shaped 404s on the delivery host", async ({ request }) => {
  const res = await request.get("/not-a-token", { headers: { host: "dl.mosni.dev" } });
  expect(res.status()).toBe(404);
});
