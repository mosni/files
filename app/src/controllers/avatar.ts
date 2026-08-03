// D-136: GET /api/avatar/<fileId> proxies auth.mosni.dev/avatar/<sub> SERVER-SIDE, so the raw sub never
// reaches the client - not in the URL, not in a header, not via a redirect. A 302 to auth would put the sub
// in the browser's URL bar and reverse D-92; this is the whole reason the proxy exists.
//
// Gated identically to the file whose uploader it names: public/unlisted are open; `secret` has no token
// mechanism on this endpoint (it is keyed purely by file id, D-81 - ids are not themselves a security
// boundary) and `private` needs identity - via EITHER a Bearer (the same elevated-access check the preview
// API already uses: owner, superuser, or an ACL grant on the file or its collection chain, D-99) OR a
// D-84-style signed URL. The signed path exists because this is rendered as a plain <img src> on the
// file's own preview page, and a browser <img> tag cannot attach a Bearer - the exact same problem D-84
// solves for a `private` file's own bytes; controllers/preview.ts's withSignedDirectUrl mints it.
//
// This is the ONE permitted exception to security invariant 2 (Node never streams file bytes,
// technical-baseline.md §1): the bytes relayed here are a small, fixed-size avatar image from
// auth.mosni.dev, never a stored/user-uploaded file.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { isSuperuser } from "../lib/roles.ts";
import { verifyDelivery } from "../lib/deliverySignature.ts";
import { hasAclGrantOnChain } from "../storage/collections.ts";
import { hasAclGrant, resolveById, resolveEffective, type ResolvedFile } from "../storage/files.ts";

async function isBearerAuthorizedForAvatar(
  request: FastifyRequest,
  config: Config,
  record: ResolvedFile,
): Promise<boolean> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) return false;
  const isOwner = record.ownerSub !== null && claims.sub === record.ownerSub;
  return (
    isOwner ||
    isSuperuser(claims) ||
    (await hasAclGrant(record.id, claims.sub)) ||
    (await hasAclGrantOnChain(record.collectionId, claims.sub))
  );
}

// D-84-style signed URL, reusing the exact same signing mechanism dl.'s signed delivery uses (it signs
// only `id\nexp`, generic to whatever resource is asking) - required because a browser <img> tag cannot
// attach a Bearer, the same reason D-84 exists for a `private` file's own bytes. withSignedDirectUrl
// (controllers/preview.ts) mints this alongside directUrl/thumbUrl for the file's own owner.
function isSignatureValidForAvatar(
  config: Config,
  fileId: string,
  query: { exp?: string; sig?: string },
): boolean {
  const expiresAt = Number(query.exp);
  const sig = query.sig;
  if (!Number.isFinite(expiresAt) || typeof sig !== "string" || sig.length === 0) return false;
  return verifyDelivery(config.deliverySigningSecret, fileId, expiresAt, sig, Date.now() / 1000);
}

export async function avatarHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  fileId: string,
  query: { exp?: string; sig?: string },
): Promise<void> {
  const record = await resolveById(fileId);
  if (record === null) {
    reply.code(404).send();
    return;
  }

  const resolved = await resolveEffective(record);
  const authorized =
    resolved.effectiveProtection === "public" ||
    resolved.effectiveProtection === "unlisted" ||
    isSignatureValidForAvatar(config, fileId, query) ||
    (await isBearerAuthorizedForAvatar(request, config, resolved));
  if (!authorized) {
    reply.code(404).send();
    return;
  }

  // D-92/D-136: no name claim was captured at upload - never fall back to the sub, and there is nothing to
  // proxy (auth's avatar route is keyed on sub, not name, but a file with no uploaderName renders no
  // uploader block at all on the client, so this URL should never even be requested for one).
  if (resolved.uploaderName === null || resolved.uploaderSub === null) {
    reply.code(404).send();
    return;
  }

  let upstream: Response;
  try {
    // auth's avatar route is public, cacheable, and never 404s on its own (verified against auth's docs,
    // session 031) - so a failure here means a network problem (e.g. the container-\>auth hairpin,
    // technical-baseline.md §4), not a missing avatar.
    upstream = await fetch(`${config.authIssuer}/avatar/${encodeURIComponent(resolved.uploaderSub)}`);
  } catch (err) {
    console.error("avatar: upstream fetch failed", err);
    reply.code(404).send();
    return;
  }
  if (!upstream.ok) {
    reply.code(404).send();
    return;
  }

  // Buffered, not streamed: this is "a small, fixed-size...image" (§0.4), never a stored/user-uploaded
  // file, so there is no invariant-2 concern in reading it fully before replying - and it sidesteps having
  // to bridge a WHATWG ReadableStream (fetch's Response.body) into Fastify's reply at all.
  const bytes = Buffer.from(await upstream.arrayBuffer());
  reply.header("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  // Long-lived: an avatar changes rarely, and this proxy exists to avoid the client ever seeing the sub,
  // not to serve fresh-every-time content.
  reply.header("Cache-Control", "public, max-age=86400");
  reply.send(bytes);
}
