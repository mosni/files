// D-4/D-5: the security-critical route. Node never streams bytes - it authorizes, then hands nginx an
// X-Accel-Redirect and an empty body. Registered on dl.mosni.dev only (Fastify's host constraint), so
// once Wave G gives dl. a proxy location, nothing but this delivery shape is reachable there at all -
// D-33's containment holds even if some other route existed in the same process.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { can } from "../lib/roles.ts";
import { contentDisposition } from "../lib/mime.ts";
import { isLinkTokenShaped } from "../lib/tokens.ts";
import { NON_RESERVED_COLLECTION_PARAM } from "../lib/paths.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { hasAclGrant, resolveByPath, resolveByToken, type FileRecord } from "../storage/files.ts";

function contentDispositionHeader(name: string): string {
  const disposition = contentDisposition(name);
  // RFC 6266: an ASCII-safe fallback for older clients, plus filename* for real UTF-8 support. Quotes in
  // the fallback are neutralised (never allowed to terminate the quoted string early).
  const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// `private` requires an authorized session whose sub matches the owner or an ACL row (byte-for-byte,
// security invariant 6), or files:admin. Distinguishes 401 (no/invalid token) from 403 (valid token,
// insufficient rights) - the same pattern the upload route uses.
async function authorizePrivate(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  record: FileRecord,
): Promise<boolean> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) {
    reply.code(401).send();
    return false;
  }
  const isOwner = record.ownerSub !== null && claims.sub === record.ownerSub;
  const isAdmin = can(claims, "files:admin");
  const granted = isOwner || isAdmin || (await hasAclGrant(record.collection, record.name, claims.sub));
  if (!granted) {
    reply.code(403).send();
    return false;
  }
  return true;
}

async function deliver(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  record: FileRecord | null,
): Promise<void> {
  if (record === null) {
    reply.code(404).send();
    return;
  }

  if (record.protection === "private" && !(await authorizePrivate(request, reply, config, record))) {
    return; // authorizePrivate already sent the 401/403
  }

  reply.header("Content-Disposition", contentDispositionHeader(record.name));
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  // Never streamed by Node (security invariant 2/D-5): nginx's `internal;` location aliases STORAGE_ROOT
  // and serves the actual bytes. Each segment is percent-encoded independently.
  reply.header(
    "X-Accel-Redirect",
    `/internal-storage/${encodeURIComponent(record.collection)}/${encodeURIComponent(record.name)}`,
  );
  reply.code(200).send();
}

export async function registerDeliveryRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const dlHost = new URL(config.dlOrigin).hostname;

  // Bare single segment: only meaningful if it is token-shaped (the `secret`/`unlisted` direct-link
  // shape, E1). Anything else has no defined meaning on this host.
  app.get("/:maybeToken", { constraints: { host: dlHost } }, async (request, reply) => {
    const { maybeToken } = request.params as { maybeToken: string };
    if (!isLinkTokenShaped(maybeToken)) {
      reply.code(404).send();
      return;
    }
    await deliver(request, reply, config, await resolveByToken(maybeToken));
  });

  app.get(
    `/${NON_RESERVED_COLLECTION_PARAM}/:name`,
    { constraints: { host: dlHost } },
    async (request, reply) => {
      const { collection, name } = request.params as { collection: string; name: string };
      const record = await resolveByPath(collection, name);
      // `secret` must 404 at its readable path, not 403 - a 403 confirms existence, which is the one
      // thing this level exists to hide (D-59).
      const gated = record !== null && !readablePathResolves(record.protection) ? null : record;
      await deliver(request, reply, config, gated);
    },
  );
}
