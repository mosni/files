// The app's first mutating API (§1.5 of the E3 waves hand-off): rename/delete for files and collections,
// protection-level changes, and collection creation/listing for the destination picker (Wave G).
// Preliminary-review P2 convention: logic here, routes/manage.ts is thin plumbing + schema validation.
//
// Authorization for every handler: owner, or `mosni_owner` (isSuperuser). DELETE /api/files/:id
// additionally allows a `files:delete` holder (D-22's surviving half). A missing/invalid Bearer is 401
// (identical response whether or not the target exists, so it leaks nothing); anything else - wrong
// owner, or no such row - is 404, never 403, matching the preview controller's existing rule that this
// app never becomes an existence oracle.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { can, isSuperuser, type Claims } from "../lib/roles.ts";
import type { Protection } from "../lib/protection.ts";
import { emitAuditEvent } from "../storage/audit.ts";
import {
  canUploadTo,
  createCollection,
  deleteCollectionRecursive,
  listCollectionsFor,
  renameCollection,
  resolveCollectionById,
  setCollectionDefaultProtection,
  type CollectionRecord,
} from "../storage/collections.ts";
import { deleteFile, renameFile, resolveById, setFileProtection, type FileRecord } from "../storage/files.ts";

const PROTECTION_LEVELS: readonly Protection[] = ["public", "unlisted", "secret", "private"];

function isProtection(value: unknown): value is Protection {
  return typeof value === "string" && (PROTECTION_LEVELS as readonly string[]).includes(value);
}

async function requireClaims(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<Claims | null> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) {
    reply.code(401).send();
    return null;
  }
  return claims;
}

function isDuplicateNameError(err: unknown, constraintName: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ER_DUP_ENTRY" &&
    new RegExp(constraintName).test((err as { message?: string }).message ?? "")
  );
}

function collectionResponse(record: CollectionRecord) {
  return {
    id: record.id,
    parentId: record.parentId,
    name: record.name,
    ownerSub: record.ownerSub,
    defaultProtection: record.defaultProtection,
  };
}

function fileResponse(record: FileRecord) {
  return { id: record.id, name: record.name, protection: record.protection };
}

// --- Collections ------------------------------------------------------------------------------------

export async function listCollections(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  const collections = await listCollectionsFor(claims.sub);
  reply.send(collections.map(collectionResponse));
}

export async function createCollectionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;

  const body = request.body as { parentId?: string; name: string };
  const parentId = body.parentId ?? "";

  if (parentId !== "") {
    const parent = await resolveCollectionById(parentId);
    if (parent === null || !(await canUploadTo(parent, claims))) {
      reply.code(404).send();
      return;
    }
  }

  try {
    const created = await createCollection({ parentId, name: body.name, ownerSub: claims.sub });
    reply.code(201).send(collectionResponse(created));
  } catch (err) {
    if (isDuplicateNameError(err, "uniq_sibling_name")) {
      reply.code(409).send({ error: "name_taken" });
      return;
    }
    throw err;
  }
}

async function authorizeCollectionOwner(
  claims: Claims,
  id: string,
): Promise<CollectionRecord | null> {
  const collection = await resolveCollectionById(id);
  if (collection === null) return null;
  if (collection.ownerSub !== claims.sub && !isSuperuser(claims)) return null;
  return collection;
}

export async function updateCollectionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;

  const { id } = request.params as { id: string };
  const collection = await authorizeCollectionOwner(claims, id);
  if (collection === null) {
    reply.code(404).send();
    return;
  }

  const body = request.body as { name?: string; defaultProtection?: string };
  if (body.name !== undefined && body.name !== collection.name) {
    try {
      await renameCollection(id, body.name);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_sibling_name")) {
        reply.code(409).send({ error: "name_taken" });
        return;
      }
      throw err;
    }
    emitAuditEvent({ action: "rename", actor: claims.sub, target: body.name });
  }
  if (body.defaultProtection !== undefined) {
    if (!isProtection(body.defaultProtection)) {
      reply.code(400).send({ error: "invalid_protection" });
      return;
    }
    await setCollectionDefaultProtection(id, body.defaultProtection);
    emitAuditEvent({
      action: "protection-change",
      actor: claims.sub,
      target: body.name ?? collection.name,
      protection: body.defaultProtection,
    });
  }

  const updated = await resolveCollectionById(id);
  reply.send(collectionResponse(updated!));
}

export async function deleteCollectionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;

  const { id } = request.params as { id: string };
  const collection = await authorizeCollectionOwner(claims, id);
  if (collection === null) {
    reply.code(404).send();
    return;
  }

  const { deletedFileIds } = await deleteCollectionRecursive(id);
  // D-46/C4: one audit line per deleted file, plus one for the collection itself.
  for (const fileId of deletedFileIds) {
    emitAuditEvent({ action: "delete", actor: claims.sub, target: fileId });
  }
  emitAuditEvent({ action: "delete", actor: claims.sub, target: collection.name });

  reply.code(204).send();
}

// --- Files --------------------------------------------------------------------------------------------

async function authorizeFileOwner(claims: Claims, id: string): Promise<FileRecord | null> {
  const record = await resolveById(id);
  if (record === null) return null;
  const isOwner = record.ownerSub !== null && record.ownerSub === claims.sub;
  if (!isOwner && !isSuperuser(claims)) return null;
  return record;
}

export async function updateFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;

  const { id } = request.params as { id: string };
  const record = await authorizeFileOwner(claims, id);
  if (record === null) {
    reply.code(404).send();
    return;
  }

  const body = request.body as { name?: string; protection?: string };
  if (body.name !== undefined && body.name !== record.name) {
    try {
      await renameFile(id, body.name);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_name_in_collection")) {
        reply.code(409).send({ error: "name_taken" });
        return;
      }
      throw err;
    }
    emitAuditEvent({ action: "rename", actor: claims.sub, target: body.name });
  }
  if (body.protection !== undefined) {
    if (!isProtection(body.protection)) {
      reply.code(400).send({ error: "invalid_protection" });
      return;
    }
    await setFileProtection(id, body.protection);
    emitAuditEvent({
      action: "protection-change",
      actor: claims.sub,
      target: body.name ?? record.name,
      protection: body.protection,
    });
  }

  const updated = await resolveById(id);
  reply.send(fileResponse(updated!));
}

export async function deleteFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;

  const { id } = request.params as { id: string };
  const record = await resolveById(id);
  if (record === null) {
    reply.code(404).send();
    return;
  }
  const isOwner = record.ownerSub !== null && record.ownerSub === claims.sub;
  const allowed = isOwner || isSuperuser(claims) || can(claims, "files:delete");
  if (!allowed) {
    reply.code(404).send();
    return;
  }

  await deleteFile(id);
  emitAuditEvent({ action: "delete", actor: claims.sub, target: record.name, protection: record.protection });
  reply.code(204).send();
}
