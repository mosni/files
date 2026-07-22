// Delivery logic for dl.mosni.dev (preliminary-review P2: logic here, routes/delivery.ts is thin).
// D-4/D-5: Node never streams bytes - it authorizes, then hands nginx an X-Accel-Redirect and an empty
// body. The security-critical path.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { isSuperuser } from "../lib/roles.ts";
import { contentDisposition } from "../lib/mime.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { hasAclGrant, resolveByPath, resolveByToken, type FileRecord } from "../storage/files.ts";

function encodeRelPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

function contentDispositionHeader(name: string): string {
  const disposition = contentDisposition(name);
  // RFC 6266: an ASCII-safe fallback for older clients, plus filename* for real UTF-8 support. Quotes in
  // the fallback are neutralised (never allowed to terminate the quoted string early).
  const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// `private` requires an authorized session whose sub matches the owner or an ACL row (byte-for-byte,
// security invariant 6), or the `mosni_owner` superuser (D-68 dropped files:admin, so that is the only
// cross-owner grant left). 401 (no/invalid token) vs 403 (valid token, insufficient rights).
//
// KNOWN GAP, flagged for E3 (which is what first lets a file BE private): a browser cannot attach a
// Bearer to an <img>/<video>/<iframe> subresource request, so the preview page's media element for a
// private file always 401s here - even for its owner. The metadata renders, the bytes do not. Closing it
// needs a delivery-side credential the browser sends by itself, which is exactly the session cookie D-75
// rejected on cost.
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
  const granted = isOwner || isSuperuser(claims) || (await hasAclGrant(record.path, claims.sub));
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
  // and serves the bytes. Each path segment is percent-encoded, slashes preserved.
  reply.header("X-Accel-Redirect", `/internal-storage/${encodeRelPath(record.path)}`);
  reply.code(200).send();
}

export async function deliverByPath(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const record = await resolveByPath(relPath);
  // `secret` must 404 at its readable path, not 403 - a 403 confirms existence, which is the one thing
  // this level exists to hide (D-59).
  const gated = record !== null && !readablePathResolves(record.protection) ? null : record;
  await deliver(request, reply, config, gated);
}

export async function deliverByToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  // The token path serves regardless of readablePathResolves - it is exactly how a `secret` file (whose
  // readable path 404s) is reached.
  await deliver(request, reply, config, await resolveByToken(token));
}
