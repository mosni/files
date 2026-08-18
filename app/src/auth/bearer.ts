// Shared bearer-token verification for plain Fastify routes (currently controllers/delivery.ts).
// routes/upload.ts does its own equivalent for tus's hooks, which receive a raw http.IncomingMessage
// rather than a FastifyRequest - not worth unifying across two different request shapes.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { verify } from "./verify.ts";
import type { VerifiedClaims } from "../lib/roles.ts";

export async function claimsFromBearer(request: FastifyRequest, audience: string): Promise<VerifiedClaims | null> {
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  try {
    return (await verify(auth.slice(7), audience)) as unknown as VerifiedClaims;
  } catch {
    return null;
  }
}

// E8 Wave C0: extracted out of controllers/share.ts, which was its only caller until controllers/admin.ts
// became a second - two controllers needing it is the point at which copying it a second time would be
// the debt working-conventions.md §3 forbids. Sends 401 and returns null itself so every caller shares one
// unauthenticated response shape.
export async function requireClaims(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<VerifiedClaims | null> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) {
    reply.code(401).send();
    return null;
  }
  return claims;
}
