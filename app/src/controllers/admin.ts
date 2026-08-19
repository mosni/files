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
import { volumeUsage } from "../storage/diskUsage.ts";
import {
  trackedBytesByOwner,
  trackedBytesTopCollections,
  trackedBytesTopFiles,
  trackedBytesTotal,
  type CollectionUsage,
  type FileUsage,
} from "../storage/usage.ts";
import { collectionPath, protectionChain } from "../storage/collections.ts";
import { mostRestrictive, type Protection } from "../lib/protection.ts";
import { buildCollectionPreviewUrl, buildFileUrls } from "../lib/fileUrls.ts";
import type { AdminCollectionUsage, AdminFileUsage, AdminGrantRow, AdminUsageResponse } from "../lib/adminContext.ts";

// Live-testing addition (2026-08-19, Hannah): "both top lists limited to the 10 largest".
const USAGE_TOP_LIMIT = 10;

// C2.1: the one shared gate. An unauthenticated caller still gets 401 - every authenticated route does,
// so it discloses nothing - and only a genuine admin ever sees past that to a real 200.
//
// It runs as an `onRequest` hook, which is the ONLY hook that precedes both body parsing and schema
// validation. Review session 059 measured the alternative: with the gate inside the handler, Fastify's AJV
// answered first, so POST /api/admin/grants/revoke returned
// `400 {"code":"FST_ERR_VALIDATION","message":"body must have required property 'targetType'"}` to an
// anonymous caller and to an authenticated non-admin alike - while a genuinely non-existent /api/admin/*
// route returned 404. Sending a deliberately malformed body therefore revealed both the endpoint and its
// exact schema, which is the disclosure D-217 exists to prevent. A `preValidation` hook is not enough
// either: an empty body fails at PARSING, earlier still.
//
// The verified claims are carried to the handler on a WeakMap rather than re-verified there - the gate has
// already done the work, and a second verify() per admin request would be pure waste.
const adminClaimsFor = new WeakMap<FastifyRequest, VerifiedClaims>();

export function adminGate(config: Config) {
  return async function gate(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const claims = await requireClaims(request, reply, config);
    if (claims === null) return reply; // 401 already sent - returning the reply halts the lifecycle
    if (!isFilesAdmin(claims)) {
      reply.code(404).send();
      return reply;
    }
    adminClaimsFor.set(request, claims);
  };
}

// Fail closed: a handler reached without the gate having run (a route registered without `onRequest`)
// answers 404 rather than serving admin data.
function requireAdmin(request: FastifyRequest, reply: FastifyReply): VerifiedClaims | null {
  const claims = adminClaimsFor.get(request);
  if (claims === undefined) {
    reply.code(404).send();
    return null;
  }
  return claims;
}

export async function listGrantsHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (requireAdmin(request, reply) === null) return;
  const grants = await listAllGrants();
  const rows: AdminGrantRow[] = grants.map((grant) => ({
    ...grant,
    grantedAt: grant.grantedAt.toISOString(),
    expiresAt: grant.expiresAt === null ? null : grant.expiresAt.toISOString(),
  }));
  reply.send({ grants: rows });
}

export async function revokeGrantHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const claims = requireAdmin(request, reply);
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

// The top lists are LINKS, not labels (Hannah, 2026-08-19), so each row needs the same URL the browse API
// would hand out for that object. That means EFFECTIVE protection - the most restrictive level along the
// ancestor chain (D-96), never the stored column - so the chain is walked here rather than guessed.
//
// At most ten rows per list, and the two lists overlap heavily in practice (the biggest files live in the
// biggest collections), so one ancestor walk per DISTINCT collection is memoised for the request. Ten rows
// on an Atom N2800 (D-78) is already cheap; this keeps it to a handful of queries rather than twenty.
function collectionResolver() {
  const cache = new Map<string, Promise<{ path: string[]; chain: Protection[] } | null>>();
  return async function resolve(collectionId: string) {
    if (collectionId === "") return { path: [], chain: [] }; // D-126: a root file has no ancestors
    let pending = cache.get(collectionId);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const [path, chain] = await Promise.all([collectionPath(collectionId), protectionChain(collectionId)]);
          return { path, chain };
        } catch {
          // A collection deleted between the aggregate and this walk - the row gets a null url and the
          // panel renders a plain label. Never fail the whole page for one stale link.
          return null;
        }
      })();
      cache.set(collectionId, pending);
    }
    return pending;
  };
}

async function shapeTopCollections(
  rows: CollectionUsage[],
  config: Config,
  resolve: ReturnType<typeof collectionResolver>,
): Promise<AdminCollectionUsage[]> {
  return Promise.all(
    rows.map(async (row) => {
      const resolved = await resolve(row.collectionId);
      const url =
        resolved === null
          ? null
          : buildCollectionPreviewUrl(config, mostRestrictive(resolved.chain), resolved.path, row.linkToken);
      return {
        collectionId: row.collectionId,
        name: row.name,
        ownerSub: row.ownerSub,
        bytes: row.bytes,
        fileCount: row.fileCount,
        url,
      };
    }),
  );
}

async function shapeTopFiles(
  rows: FileUsage[],
  config: Config,
  resolve: ReturnType<typeof collectionResolver>,
): Promise<AdminFileUsage[]> {
  return Promise.all(
    rows.map(async (row) => {
      const resolved = await resolve(row.collectionId);
      const url =
        resolved === null
          ? null
          : buildFileUrls(config, mostRestrictive([...resolved.chain, row.protection]), [...resolved.path, row.name], row.linkToken)
              .previewUrl;
      return {
        fileId: row.fileId,
        name: row.name,
        collectionName: row.collectionName,
        ownerSub: row.ownerSub,
        bytes: row.bytes,
        url,
      };
    }),
  );
}

export async function usageHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  if (requireAdmin(request, reply) === null) return;

  const [volume, tracked, byOwner, topCollectionRows, topFileRows] = await Promise.all([
    volumeUsage(config.storageRoot),
    trackedBytesTotal(),
    trackedBytesByOwner(),
    trackedBytesTopCollections(USAGE_TOP_LIMIT),
    trackedBytesTopFiles(USAGE_TOP_LIMIT),
  ]);
  const resolve = collectionResolver();
  const [topCollections, topFiles] = await Promise.all([
    shapeTopCollections(topCollectionRows, config, resolve),
    shapeTopFiles(topFileRows, config, resolve),
  ]);

  // Clamped at 0: the volume is shared with other apps on the box (technical-baseline.md), so the delta
  // can go negative - a negative "untracked" figure would read as a bug rather than as the imprecision it
  // actually is.
  const untrackedBytes = volume === null ? null : Math.max(0, volume.usedBytes - tracked.bytes);

  const body: AdminUsageResponse = { volume, tracked, untrackedBytes, byOwner, topCollections, topFiles };
  reply.send(body);
}
