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

// The issuer comes from validated config (AUTH_ISSUER, already required by config.ts and already present
// in .env.example - it was simply never read here, so the config lied about being used). Defaulting to
// the real issuer keeps production behaviour identical if init is never called. Making it configurable is
// what allows the e2e tier to point at a throwaway IdP and finally exercise a REAL authorized upload -
// until now every authorized path was reachable only by mocking this module, which meant the product
// invariant had no end-to-end coverage at all.
//
// Nothing else about the vendored snippet changes: RS256 pinned, audience required, JWKS fetched from the
// issuer's well-known document. D-11's re-review obligation still stands.
const DEFAULT_ISSUER = "https://auth.mosni.dev";

let issuer = DEFAULT_ISSUER;
let jwks = createRemoteJWKSet(new URL(`${DEFAULT_ISSUER}/.well-known/jwks.json`));

export function initVerify(authIssuer: string): void {
  issuer = authIssuer;
  jwks = createRemoteJWKSet(new URL(`${authIssuer}/.well-known/jwks.json`));
}

export async function verify(token: string, audience: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience, // required - reject if omitted
    algorithms: ["RS256"], // pin - never accept alg:none or HS*
  });
  return payload;
}
