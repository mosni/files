// Vendored verbatim from ../auth/packages/verify-ts/README.md -> "Copy-paste alternative (no
// dependency)" (D-11), 2026-07-19. Chosen over the @mosni/auth GitHub Packages dependency so the OIDC
// deploy never needs a stored NODE_AUTH_TOKEN.
//
// D-11's standing obligation: re-review this snippet whenever mosni/auth changes its verify contract.
//
// D-2: this app has a single origin, so every call site passes audience = "https://files.mosni.dev".
//
// Deliberately does NOT vendor or export the snippet's own can(): it implements only
// `mosni_owner === true || roles.includes(role)`, which does not provide D-22's implication
// (files:admin => files:write + files:delete) - see D-49. Route code must import `can` from
// `lib/roles.ts` instead; this module exposes verification only.

import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.mosni.dev";
const JWKS = createRemoteJWKSet(new URL("https://auth.mosni.dev/.well-known/jwks.json"));

export async function verify(token: string, audience: string) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ISSUER,
    audience, // required - reject if omitted
    algorithms: ["RS256"], // pin - never accept alg:none or HS*
  });
  return payload;
}
