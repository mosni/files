// Delivery logic for dl.mosni.dev (preliminary-review P2: logic here, routes/delivery.ts is thin).
// D-4/D-5: Node never streams bytes - it authorizes, then hands nginx an X-Accel-Redirect and an empty
// body. The security-critical path.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { isSuperuser } from "../lib/roles.ts";
import { contentDisposition, mimeTypeFor } from "../lib/mime.ts";
import { safeSegments } from "../lib/paths.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { verifyDelivery } from "../lib/deliverySignature.ts";
import {
  diskRelPath,
  hasAclGrant,
  resolveById,
  resolveByNames,
  resolveByToken,
  type FileRecord,
} from "../storage/files.ts";

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
// cross-owner grant left, besides the D-84 signed-URL route below). 401 (no/invalid token) vs 403 (valid
// token, insufficient rights).
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
  const granted = isOwner || isSuperuser(claims) || (await hasAclGrant(record.id, claims.sub));
  if (!granted) {
    reply.code(403).send();
    return false;
  }
  return true;
}

function sendBytes(reply: FastifyReply, record: FileRecord): void {
  // D-90: the app decides Content-Type from the DISPLAY name (invariant 3's inline-vs-attachment call
  // already reads the same name) - nginx's on-disk extension inference is no longer load-bearing, and
  // under D-82 the disk name is the ORIGINAL filename, pinned forever, so it can permanently disagree
  // with a renamed display name.
  reply.header("Content-Type", mimeTypeFor(record.name));
  reply.header("Content-Disposition", contentDispositionHeader(record.name));
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  // Never streamed by Node (security invariant 2/D-5): nginx's `internal;` location aliases STORAGE_ROOT
  // and serves the bytes. Each path segment is percent-encoded, slashes preserved.
  reply.header("X-Accel-Redirect", `/internal-storage/${encodeRelPath(diskRelPath(record))}`);
  reply.code(200).send();
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
  sendBytes(reply, record);
}

export async function deliverByPath(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const segments = safeSegments(relPath);
  const record = segments === null ? null : await resolveByNames(segments);
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

// D-84: a `private` file's bytes, reachable via a short-lived signed URL - dl.mosni.dev/s/<id>?exp=&sig=.
// No Bearer is read here and no cookie is ever set (D-33 forbids one on this origin outright); an invalid
// or expired signature returns 404, never 403, matching every other "does this exist" question this
// origin refuses to answer honestly for an unauthorized caller.
export async function deliverSigned(
  _request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  fileId: string,
  query: { exp?: string; sig?: string },
): Promise<void> {
  const expiresAt = Number(query.exp);
  const sig = query.sig;
  if (!Number.isFinite(expiresAt) || typeof sig !== "string" || sig.length === 0) {
    reply.code(404).send();
    return;
  }
  const valid = verifyDelivery(config.deliverySigningSecret, fileId, expiresAt, sig, Date.now() / 1000);
  if (!valid) {
    reply.code(404).send();
    return;
  }
  const record = await resolveById(fileId);
  if (record === null) {
    reply.code(404).send();
    return;
  }
  sendBytes(reply, record);
}
