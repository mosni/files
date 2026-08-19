#!/usr/bin/env node
// A throwaway OIDC-ish issuer for the e2e tier, and nothing else. It exists so the suite can exercise a
// REAL authorized upload: before this, every authorized path was reachable only by `vi.mock`-ing
// app/src/auth/verify.ts, which meant the product invariant (open -> drop -> copy a working link) had no
// end-to-end coverage at all - the server's tus tests and the drop zone's component tests each passed
// against the other's absence.
//
// It is a genuine RS256 issuer: it generates a keypair on boot, publishes a real JWKS, and signs real
// tokens that the app's own unmodified verify() accepts. Nothing in the app is stubbed or bypassed.
//
// NEVER reachable from production: it is a service in docker-compose.verify.yml only, and the app points
// at it solely because that compose file sets AUTH_ISSUER to this container.
//
//   GET /.well-known/jwks.json          the public key set
//   GET /token?sub=&roles=&name=        mint a signed access token
//
// It ALSO stands in for auth's internal-only listener on a second port (review 060/SEC-6), because
// POST /api/shares now validates a grantee against auth's account directory rather than accepting any
// string - so without a directory here, every e2e share would 502. The compose file gives this service the
// `auth` network alias and this process listens on 3001 as well, which is the fixed address
// app/src/auth/internalApi.ts uses:
//
//   GET /internal/accounts              every sub this issuer has ever minted a token for
//
// "Minted a token for" is a deliberately faithful stand-in for auth's own `WHERE link_id IS NULL`: an
// account exists in the directory once it has actually signed in, which is exactly what a spec calling
// mintToken() has simulated. A sub nobody ever authenticated as is correctly absent, so the negative case
// stays real too.
//
// Usage: node e2e/mock-idp.mjs [port]

import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = Number(process.argv[2] ?? 9000);
// Must match what the app is configured with (docker-compose.verify.yml sets both), because the token's
// `iss` is checked against it.
const ISSUER = process.env.MOCK_ISSUER ?? `http://mock-idp:${PORT}`;
const AUDIENCE = process.env.MOCK_AUDIENCE ?? "https://files-e2e.test";

// The internal-API port is auth's own documented default and is hardcoded in the app
// (auth/internalApi.ts's AUTH_INTERNAL_API) - it is not configurable there, so it is not configurable here.
const INTERNAL_PORT = 3001;

// Every sub this issuer has minted a token for, in mint order. A Set, so a spec that mints twice for the
// same sub (the owner in a multi-step flow) does not produce a duplicate directory row.
const knownSubs = new Set();

const KEY_ID = "e2e-mock-key";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };

async function mintToken({ sub, roles, name, mosniOwner }) {
  knownSubs.add(sub);
  const claims = { roles };
  if (name) claims.name = name;
  if (mosniOwner) claims.mosni_owner = true;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(privateKey);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/.well-known/jwks.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }

  if (url.pathname === "/token") {
    const token = await mintToken({
      sub: url.searchParams.get("sub") ?? "user:e2e",
      roles: (url.searchParams.get("roles") ?? "files:write").split(",").filter(Boolean),
      name: url.searchParams.get("name") ?? undefined,
      mosniOwner: url.searchParams.get("mosni_owner") === "true",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, issuer: ISSUER, audience: AUDIENCE }));
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock-idp listening on ${PORT} as ${ISSUER} (aud ${AUDIENCE})`);
});

// auth's internal listener, on its own port and reachable only as `auth:3001` on the compose network -
// mirroring the real thing, which compose never publishes and nginx never proxies. The app's own network
// alias IS the authentication for these routes (there is no caller verification), exactly as documented in
// app/src/auth/internalApi.ts.
const internalServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${INTERNAL_PORT}`);

  if (url.pathname === "/internal/accounts") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([...knownSubs].map((sub) => ({ sub, name: null, picture: null }))));
    return;
  }

  // Deliberately NOT implemented: /internal/links (invite minting) and /internal/roles. No e2e spec drives
  // a real mint - e2e/share.spec.ts asserts the AUTHORIZATION half of invites (a grantee gets 404), which
  // never reaches auth - and answering 404 here keeps that honest rather than pretending a link was made.
  res.writeHead(404).end();
});

internalServer.listen(INTERNAL_PORT, "0.0.0.0", () => {
  console.log(`mock-idp internal API listening on ${INTERNAL_PORT}`);
});
