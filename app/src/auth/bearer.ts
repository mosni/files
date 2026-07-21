// Shared bearer-token verification for plain Fastify routes (currently controllers/delivery.ts).
// routes/upload.ts does its own equivalent for tus's hooks, which receive a raw http.IncomingMessage
// rather than a FastifyRequest - not worth unifying across two different request shapes.

import type { FastifyRequest } from "fastify";
import { verify } from "./verify.ts";
import type { Claims } from "../lib/roles.ts";

export async function claimsFromBearer(request: FastifyRequest, audience: string): Promise<Claims | null> {
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  try {
    return (await verify(auth.slice(7), audience)) as unknown as Claims;
  } catch {
    return null;
  }
}
