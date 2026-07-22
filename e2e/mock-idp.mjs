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
// Usage: node e2e/mock-idp.mjs [port]

import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = Number(process.argv[2] ?? 9000);
// Must match what the app is configured with (docker-compose.verify.yml sets both), because the token's
// `iss` is checked against it.
const ISSUER = process.env.MOCK_ISSUER ?? `http://mock-idp:${PORT}`;
const AUDIENCE = process.env.MOCK_AUDIENCE ?? "https://files-e2e.test";

const KEY_ID = "e2e-mock-key";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };

async function mintToken({ sub, roles, name, mosniOwner }) {
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
