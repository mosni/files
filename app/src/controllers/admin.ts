// E8's admin API (D-217 … D-221). Gated on isFilesAdmin (D-68). Every handler answers 404 - never 403 -
// to an authenticated non-admin (D-217): a 403 would confirm the panel exists, and this app's private
// objects already answer this way.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { requireClaims } from "../auth/bearer.ts";
import { isFilesAdmin, type VerifiedClaims } from "../lib/roles.ts";
import { actorLabel } from "../lib/audit.ts";
import { emitAuditEvent } from "../storage/audit.ts";
import { listAllGrants } from "../storage/grants.ts";
import { resolveById, revokeFileAcl } from "../storage/files.ts";
import { resolveCollectionById, revokeCollectionAcl } from "../storage/collections.ts";
import { setAccountRole } from "../auth/internalApi.ts";
import { volumeUsage } from "../lib/diskUsage.ts";
import { trackedBytesByOwner, trackedBytesTopCollections, trackedBytesTotal } from "../storage/usage.ts";
import type { AdminGrantRow, AdminUsageResponse } from "../lib/adminContext.ts";

const USAGE_TOP_COLLECTIONS_LIMIT = 10;

// C2.1: the one shared gate. An unauthenticated caller still gets 401 - every authenticated route does,
// so it discloses nothing - and only a genuine admin ever sees past that to a real 200.
async function requireAdmin(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<VerifiedClaims | null> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return null;
  if (!isFilesAdmin(claims)) {
    reply.code(404).send();
    return null;
  }
  return claims;
}

export async function listGrantsHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireAdmin(request, reply, config);
  if (claims === null) return;
  const grants = await listAllGrants();
  const rows: AdminGrantRow[] = grants.map((grant) => ({
    ...grant,
    grantedAt: grant.grantedAt.toISOString(),
    expiresAt: grant.expiresAt === null ? null : grant.expiresAt.toISOString(),
  }));
  reply.send({ grants: rows });
}

export async function revokeGrantHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireAdmin(request, reply, config);
  if (claims === null) return;
  const body = request.body as { targetType?: string; targetId?: string; sub?: string };
  if (
    (body.targetType !== "file" && body.targetType !== "collection") ||
    typeof body.targetId !== "string" ||
    typeof body.sub !== "string" ||
    body.sub.length === 0
  ) {
    reply.code(400).send({ error: "bad_request" });
    return;
  }

  // Resolved BEFORE the delete so the audit line can name the object - revoking an already-gone or
  // already-expired grant is still not an error (the DELETE is idempotent and an admin clicking twice must
  // not see a failure), so a vanished object falls back to its raw id rather than blocking the revoke.
  const targetName =
    body.targetType === "file"
      ? ((await resolveById(body.targetId))?.name ?? body.targetId)
      : ((await resolveCollectionById(body.targetId))?.name ?? body.targetId);

  if (body.targetType === "file") {
    await revokeFileAcl(body.targetId, body.sub);
  } else {
    await revokeCollectionAcl(body.targetId, body.sub);
  }
  // D-192's same best-effort, silent, result-ignored cleanup - a dead auth must never block a revoke.
  await setAccountRole(body.sub, "files:read", "remove");
  emitAuditEvent({ action: "share-change", actor: actorLabel(claims), target: targetName });
  reply.send({});
}

export async function usageHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireAdmin(request, reply, config);
  if (claims === null) return;

  const [volume, tracked, byOwner, topCollections] = await Promise.all([
    volumeUsage(config.storageRoot),
    trackedBytesTotal(),
    trackedBytesByOwner(),
    trackedBytesTopCollections(USAGE_TOP_COLLECTIONS_LIMIT),
  ]);

  // Clamped at 0: the volume is shared with other apps on the box (technical-baseline.md), so the delta
  // can go negative - a negative "untracked" figure would read as a bug rather than as the imprecision it
  // actually is.
  const untrackedBytes = volume === null ? null : Math.max(0, volume.usedBytes - tracked.bytes);

  const body: AdminUsageResponse = { volume, tracked, untrackedBytes, byOwner, topCollections };
  reply.send(body);
}
