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
import { can, isSuperuser, type Claims, type VerifiedClaims } from "../lib/roles.ts";
import { mostRestrictive, PROTECTION_ORDER, type Protection } from "../lib/protection.ts";
import { isReservedRootName, safeSegment } from "../lib/paths.ts";
import { actorLabel } from "../lib/audit.ts";
import { buildCollectionPreviewUrl } from "../lib/fileUrls.ts";
import { ownerContextFor } from "./preview.ts";
import { emitAuditEvent } from "../storage/audit.ts";
import {
  canUploadTo,
  collectionPath,
  countDescendants,
  createCollection,
  deleteCollectionRecursive,
  isDescendantOf,
  listCollectionsFor,
  moveCollection,
  protectionChain,
  renameCollection,
  resolveCollectionById,
  setCollectionDefaultProtection,
  setCollectionProtection,
  type CollectionRecord,
} from "../storage/collections.ts";
import {
  deleteFile,
  moveFile,
  renameFile,
  resolveById,
  setFileProtection,
  type FileRecord,
} from "../storage/files.ts";

const PROTECTION_LEVELS: readonly Protection[] = ["public", "unlisted", "secret", "private"];

function isProtection(value: unknown): value is Protection {
  return typeof value === "string" && (PROTECTION_LEVELS as readonly string[]).includes(value);
}

// D-97: the write-time floor. `parentChain` is the set of already-effective levels the requested value
// must not be looser than - the collection's own chain (self-inclusive) for a file's protection or a
// collection's default_protection, or the PARENT's chain for a collection's own protection. An empty
// chain (nothing above a root collection) means there is no floor to check. Raising a parent is always
// allowed and is exactly what makes a previously-valid child value fail this check later - the check
// itself never rewrites anything, only gates what may be WRITTEN going forward (D-97).
function meetsParentFloor(requested: Protection, parentChain: readonly Protection[]): boolean {
  if (parentChain.length === 0) return true;
  return PROTECTION_ORDER[requested] >= PROTECTION_ORDER[mostRestrictive(parentChain)];
}

async function requireClaims(
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

// A display name IS a URL segment: post-D-81 both `/f/<collection>/.../<name>` and `dl.mosni.dev/...`
// resolve through the database BY display name, and routes/preview.ts + routes/delivery.ts reject any
// segment failing safeSegment() before they ever query. So a name this API accepts but safeSegment()
// would not is a name whose own readable link can never resolve again - the row survives, the `/t/<token>`
// link keeps working, and the app's own copy control quietly offers a dead URL. Uploads have always run
// their filename through safeSegment(); rename and collection-create must apply exactly the same rule, or
// the boundary is only half a boundary.
//
// `reservedRoot` additionally rejects a root-level collection name that would shadow a static route
// (lib/paths.ts's isReservedRootName). Returns null when the name is unusable.
function validatedName(value: string, opts: { rootLevel: boolean }): string | null {
  const safe = safeSegment(value);
  if (safe === null) return null;
  if (opts.rootLevel && isReservedRootName(safe)) return null;
  return safe;
}

function isDuplicateNameError(err: unknown, constraintName: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ER_DUP_ENTRY" &&
    new RegExp(constraintName).test((err as { message?: string }).message ?? "")
  );
}

// E6 A5 (D-175): gains `previewUrl` - grouping needs a link to show for the collection it just created. A
// newly-created collection is at the root and inherits `unlisted` (D-105), so buildCollectionPreviewUrl
// returns the `/f/<name>` shape - do not assume the token shape holds for every caller of this function.
async function collectionResponse(config: Config, record: CollectionRecord) {
  return {
    id: record.id,
    parentId: record.parentId,
    name: record.name,
    ownerSub: record.ownerSub,
    protection: record.protection,
    defaultProtection: record.defaultProtection,
    previewUrl: buildCollectionPreviewUrl(config, record.protection, await collectionPath(record.id), record.linkToken),
  };
}


// --- Collections ------------------------------------------------------------------------------------

export async function listCollections(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  const collections = await listCollectionsFor(claims.sub);
  reply.send(await Promise.all(collections.map((record) => collectionResponse(config, record))));
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

  const name = validatedName(body.name, { rootLevel: parentId === "" });
  if (name === null) {
    reply.code(400).send({ error: "invalid_name" });
    return;
  }

  // D-105: a new collection inherits its parent's EFFECTIVE protection (not just the parent's own stored
  // value - a grandparent above it may be stricter), `unlisted` at root, matching the column default.
  let protection: Protection = "unlisted";
  if (parentId !== "") {
    const parent = await resolveCollectionById(parentId);
    if (parent === null || !(await canUploadTo(parent, claims))) {
      reply.code(404).send();
      return;
    }
    protection = mostRestrictive(await protectionChain(parentId));
  }

  try {
    const created = await createCollection({ parentId, name, ownerSub: claims.sub, protection });
    reply.code(201).send(await collectionResponse(config, created));
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

  const body = request.body as {
    name?: string;
    protection?: string;
    defaultProtection?: string;
    parentId?: string;
  };
  if (body.name !== undefined && body.name !== collection.name) {
    const name = validatedName(body.name, { rootLevel: collection.parentId === "" });
    if (name === null) {
      reply.code(400).send({ error: "invalid_name" });
      return;
    }
    try {
      await renameCollection(id, name);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_sibling_name")) {
        reply.code(409).send({ error: "name_taken" });
        return;
      }
      throw err;
    }
    emitAuditEvent({ action: "rename", actor: actorLabel(claims), target: body.name });
  }
  if (body.protection !== undefined) {
    if (!isProtection(body.protection)) {
      reply.code(400).send({ error: "invalid_protection" });
      return;
    }
    // D-97: floored by the PARENT's effective chain - raising this collection's own level is always
    // allowed and rewrites nothing beneath it; lowering below the parent is what the floor rejects.
    const parentChain = collection.parentId === "" ? [] : await protectionChain(collection.parentId);
    if (!meetsParentFloor(body.protection, parentChain)) {
      reply.code(400).send({ error: "below_parent_protection" });
      return;
    }
    await setCollectionProtection(id, body.protection);
    emitAuditEvent({
      action: "protection-change",
      actor: actorLabel(claims),
      target: body.name ?? collection.name,
      protection: body.protection,
    });
  }
  if (body.defaultProtection !== undefined) {
    if (!isProtection(body.defaultProtection)) {
      reply.code(400).send({ error: "invalid_protection" });
      return;
    }
    // D-97: floored by the collection's OWN effective chain (self-inclusive) - default_protection is
    // what new uploads inherit, and a value looser than the collection's own effective level would be
    // silently overridden at read time anyway (D-96), so the floor keeps the setting from lying about
    // what new uploads will actually be. Read fresh so a `protection` change earlier in this same
    // request is reflected.
    const ownChain = await protectionChain(id);
    if (!meetsParentFloor(body.defaultProtection, ownChain)) {
      reply.code(400).send({ error: "below_parent_protection" });
      return;
    }
    await setCollectionDefaultProtection(id, body.defaultProtection);
    emitAuditEvent({
      action: "protection-change",
      actor: actorLabel(claims),
      target: body.name ?? collection.name,
      protection: body.defaultProtection,
    });
  }
  if (body.parentId !== undefined) {
    // D-130 (E4.1 live-testing findings, Wave C3): move, plus the cycle check a file's move does not need.
    const destinationId = body.parentId;
    if (destinationId === id || (await isDescendantOf(id, destinationId))) {
      reply.code(400).send({ error: "invalid_destination" });
      return;
    }
    let destinationChain: Protection[];
    if (destinationId === "") {
      destinationChain = [];
    } else {
      const destination = await resolveCollectionById(destinationId);
      if (destination === null || !(await canUploadTo(destination, claims))) {
        reply.code(404).send();
        return;
      }
      destinationChain = await protectionChain(destinationId);
    }
    // Floor direction for a collection's OWN protection is the DESTINATION's chain - matching this same
    // handler's existing `protection` branch, which floors against the (current) parent's chain.
    if (!meetsParentFloor(collection.protection, destinationChain)) {
      reply.code(400).send({ error: "below_parent_protection" });
      return;
    }
    if (destinationId === "" && isReservedRootName(collection.name)) {
      reply.code(400).send({ error: "invalid_name" });
      return;
    }
    try {
      await moveCollection(id, destinationId);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_sibling_name")) {
        reply.code(409).send({ error: "name_taken" });
        return;
      }
      throw err;
    }
    emitAuditEvent({ action: "move", actor: actorLabel(claims), target: body.name ?? collection.name });
  }

  const updated = await resolveCollectionById(id);
  reply.send(await collectionResponse(config, updated!));
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

  // D-104: the browser's recursive-delete confirmation names the descendant count before the owner
  // commits to it - a dry run reports the same counts deleteCollectionRecursive would act on, without
  // touching a row.
  //
  // The PRESENCE of the parameter is what counts, not its value - so `?dryRun=false` is still a dry run.
  // That is deliberate and fails closed: D-88 calls recursive collection delete the most destructive
  // operation in the app, and a caller who wrote the parameter at all clearly did not mean to delete. A
  // real delete is the request with no `dryRun` at all.
  const query = request.query as { dryRun?: string };
  if (query.dryRun !== undefined) {
    reply.send(await countDescendants(id));
    return;
  }

  const { deletedFileIds } = await deleteCollectionRecursive(id);
  // Live-testing fix (2026-08-06, Hannah: bulk operations should notify once, not per action). This used
  // to emit one line PER deleted file - each naming a raw file id, since the rows are gone by the time
  // this runs and only the ids come back - plus one for the collection. A recursive delete is ONE action
  // by ONE person, so it gets ONE line naming the collection and how many files went with it.
  //
  // This also removes the only unbounded audit burst in the app: deleting a large subtree used to fire a
  // request per file at bot-core simultaneously, which is the most likely reason Hannah saw notifications
  // go missing (a burst-rate-limited relay silently dropping the overflow, invisible here because the
  // emitter is fire-and-forget by design).
  emitAuditEvent({
    action: "delete",
    actor: actorLabel(claims),
    target: collection.name,
    count: deletedFileIds.length,
  });

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

  const body = request.body as { name?: string; protection?: string; collectionId?: string };
  if (body.name !== undefined && body.name !== record.name) {
    // A6 (E4.1 live-testing findings, Wave A): a root-level file gets the same reserved-root-name check a
    // root collection already had - otherwise it could be renamed to "t" and shadow the static /t/:token
    // route on dl.mosni.dev.
    const name = validatedName(body.name, { rootLevel: record.collectionId === "" });
    if (name === null) {
      reply.code(400).send({ error: "invalid_name" });
      return;
    }
    try {
      await renameFile(id, name);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_name_in_collection")) {
        reply.code(409).send({ error: "name_taken" });
        return;
      }
      throw err;
    }
    emitAuditEvent({ action: "rename", actor: actorLabel(claims), target: body.name });
  }
  if (body.protection !== undefined) {
    if (!isProtection(body.protection)) {
      reply.code(400).send({ error: "invalid_protection" });
      return;
    }
    // D-97: floored by the owning collection's effective chain (self-inclusive) - raising the collection
    // later is what may make a currently-valid file value fail this check, and that is by design. A
    // root-level file's chain is empty (D-126), so there is no floor - `public` becomes settable.
    const chain = await protectionChain(record.collectionId);
    if (!meetsParentFloor(body.protection, chain)) {
      reply.code(400).send({ error: "below_parent_protection" });
      return;
    }
    await setFileProtection(id, body.protection);
    emitAuditEvent({
      action: "protection-change",
      actor: actorLabel(claims),
      target: body.name ?? record.name,
      protection: body.protection,
    });
  }
  if (body.collectionId !== undefined) {
    // D-130 (E4.1 live-testing findings, Wave C2): move. Authorization is the existing owner/superuser
    // gate above (authorizeFileOwner) - move is a manage action (D-104), not a delete action (D-115), so
    // it is never widened to a files:delete holder.
    const destinationId = body.collectionId;
    let destinationChain: Protection[];
    if (destinationId === "") {
      destinationChain = [];
    } else {
      const destination = await resolveCollectionById(destinationId);
      // A destination that does not resolve, or that this caller may not upload into, is a 404 - never
      // 403 (this app never becomes an existence oracle), matching every other authorization gate here.
      if (destination === null || !(await canUploadTo(destination, claims))) {
        reply.code(404).send();
        return;
      }
      destinationChain = await protectionChain(destinationId);
    }
    // D-97's floor, re-checked at the DESTINATION - a move that would breach it is rejected, never
    // silently re-levelled (Wave F makes the rejection visible to the user).
    if (!meetsParentFloor(record.protection, destinationChain)) {
      reply.code(400).send({ error: "below_parent_protection" });
      return;
    }
    if (destinationId === "" && isReservedRootName(record.name)) {
      reply.code(400).send({ error: "invalid_name" });
      return;
    }
    try {
      await moveFile(id, destinationId);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_name_in_collection")) {
        reply.code(409).send({ error: "name_taken" });
        return;
      }
      throw err;
    }
    emitAuditEvent({ action: "move", actor: actorLabel(claims), target: record.name });
  }

  // The full preview context, not just the changed fields: a rename, protection change or move retires
  // the file's previewUrl/directUrl, and the SPA has no way to recompute them (it never sees the
  // link_token).
  const updated = await resolveById(id);
  reply.send(await ownerContextFor(config, updated!));
}

// Live-testing addition (2026-08-06, Hannah: "moving a grouped set of uploads" should notify once).
// Moves many files into one destination in a SINGLE request, so it is one action server-side and emits
// exactly one audit line. Before this, E6's upload grouping issued one `PATCH /api/files/:id` per file -
// each a legitimately separate action as far as the server could tell, so it produced N audit lines and N
// simultaneous bot-core POSTs. No amount of server-side cleverness could group those; the requests had to
// stop being separate.
//
// Partial failure is REPORTED, never rolled back - the hand-off rule this flow already had ("grouping must
// never lose a file") means a file that could not move stays exactly where it was, and the caller is told
// which ones those are. A file the caller may not touch is skipped as `not_found`, matching the single
// handler's rule that this app never becomes an existence oracle - it never fails the whole batch.
export async function moveFilesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;

  const body = request.body as { ids: string[]; collectionId: string };
  const destinationId = body.collectionId;

  // Resolved ONCE for the whole batch, not per file: the destination is the same for every id, and
  // re-walking the ancestor chain per file is the exact per-row re-walk review session 022 removed from
  // the browse API for the same reason.
  let destinationChain: Protection[];
  let destinationLabel = "/";
  if (destinationId === "") {
    destinationChain = [];
  } else {
    const destination = await resolveCollectionById(destinationId);
    if (destination === null || !(await canUploadTo(destination, claims))) {
      reply.code(404).send();
      return;
    }
    destinationChain = await protectionChain(destinationId);
    destinationLabel = destination.name;
  }

  const moved: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of body.ids) {
    const record = await authorizeFileOwner(claims, id);
    if (record === null) {
      failed.push({ id, error: "not_found" });
      continue;
    }
    // Same D-97 floor the single move applies, per file - a batch is not a way around it.
    if (!meetsParentFloor(record.protection, destinationChain)) {
      failed.push({ id, error: "below_parent_protection" });
      continue;
    }
    if (destinationId === "" && isReservedRootName(record.name)) {
      failed.push({ id, error: "invalid_name" });
      continue;
    }
    try {
      await moveFile(id, destinationId);
      moved.push(id);
    } catch (err) {
      if (isDuplicateNameError(err, "uniq_name_in_collection")) {
        failed.push({ id, error: "name_taken" });
        continue;
      }
      throw err;
    }
  }

  // ONE line for the whole batch (the entire point of this endpoint). Suppressed when nothing moved -
  // a batch that failed outright is not a write worth announcing.
  if (moved.length > 0) {
    emitAuditEvent({
      action: "move",
      actor: actorLabel(claims),
      target: destinationLabel,
      count: moved.length,
    });
  }

  reply.send({ moved, failed });
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
  emitAuditEvent({ action: "delete", actor: actorLabel(claims), target: record.name, protection: record.protection });
  reply.code(204).send();
}
