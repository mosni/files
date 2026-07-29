// D-80: collections are real, nested DB entities - never called "folders" (Hannah's explicit
// terminology call). This is the only module that queries the `collections`/`collection_acl` tables;
// storage/files.ts stays the only module that queries `files`/`file_acl` and touches the filesystem, but
// recursive collection delete needs both, so it lives here and calls into files.ts's per-file deleteFile.

import type { RowDataPacket } from "mysql2/promise";
import type { Claims } from "../lib/roles.ts";
import { isSuperuser } from "../lib/roles.ts";
import { generateId } from "../lib/ids.ts";
import { mostRestrictive, type Protection } from "../lib/protection.ts";
import { mintUniqueToken } from "../lib/tokens.ts";
import { deleteFile } from "./files.ts";
import { getPool, isLinkTokenTaken } from "./db.ts";

export type CollectionRecord = {
  id: string;
  parentId: string;
  name: string;
  ownerSub: string;
  // D-95: the collection's OWN visibility - a distinct thing from defaultProtection below (D-86: what new
  // uploads into it inherit). Never blur the two.
  protection: Protection;
  defaultProtection: Protection;
  linkToken: string;
  createdAt: string;
};

interface CollectionRow extends RowDataPacket {
  id: string;
  parent_id: string;
  name: string;
  owner_sub: string;
  protection: Protection;
  default_protection: Protection;
  link_token: string;
  created_at: Date;
}

function rowToRecord(row: CollectionRow): CollectionRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    ownerSub: row.owner_sub,
    protection: row.protection,
    defaultProtection: row.default_protection,
    linkToken: row.link_token,
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT_COLUMNS =
  "id, parent_id, name, owner_sub, protection, default_protection, link_token, created_at";

// A cycle should never exist (parent_id only ever points at a real ancestor created before it), but this
// is app-generated data feeding a loop, so a future bug elsewhere must not be able to hang a request.
const MAX_COLLECTION_DEPTH = 32;

export async function resolveCollectionByNames(
  segments: readonly string[],
): Promise<CollectionRecord | null> {
  if (segments.length === 0) return null; // root ('') is a pseudo-id, never a real row

  let parentId = "";
  let current: CollectionRecord | null = null;
  for (const segment of segments) {
    const [rows] = await getPool().query<CollectionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM collections WHERE parent_id = ? AND name = ?`,
      [parentId, segment],
    );
    const row = rows[0];
    if (row === undefined) return null;
    current = rowToRecord(row);
    parentId = current.id;
  }
  return current;
}

export async function resolveCollectionById(id: string): Promise<CollectionRecord | null> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : rowToRecord(row);
}

// D-107/E4-COLLECTION-TOKEN-UNRESOLVED: the collection half of files.ts's resolveByToken - mirrors its
// shape exactly (same null-on-miss contract), so a collection's /t/<token> share link has somewhere to
// resolve to. Unlike a file, a collection has no bytes and nothing to stat() - the row itself is the
// whole answer.
export async function resolveCollectionByToken(token: string): Promise<CollectionRecord | null> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE link_token = ?`,
    [token],
  );
  const row = rows[0];
  return row === undefined ? null : rowToRecord(row);
}

// D-96 applied to a collection itself rather than to a file inside one: mirrors storage/files.ts's
// resolveEffective, but protectionChain(record.id) already returns root-first levels DOWN TO AND
// INCLUDING this collection's own row (see its doc comment above), so there is no separate "own level" to
// fold in afterward the way a file's collectionId (its PARENT) requires.
export type ResolvedCollection = CollectionRecord & { effectiveProtection: Protection };

export async function resolveCollectionEffective(record: CollectionRecord): Promise<ResolvedCollection> {
  const chain = await protectionChain(record.id);
  return { ...record, effectiveProtection: mostRestrictive(chain) };
}

// The shared ancestor walk: root-first CollectionRecord[] from root down to (and including) this
// collection. collectionPath, protectionChain and collectionBreadcrumb below are each just a different
// projection of the same records.
async function ancestorChainRecords(id: string): Promise<CollectionRecord[]> {
  const records: CollectionRecord[] = [];
  let currentId = id;
  for (let depth = 0; depth < MAX_COLLECTION_DEPTH; depth++) {
    const record = await resolveCollectionById(currentId);
    if (record === null) {
      throw new Error(`storage/collections: ancestorChainRecords - dangling parent_id "${currentId}"`);
    }
    records.unshift(record);
    if (record.parentId === "") return records;
    currentId = record.parentId;
  }
  throw new Error(`storage/collections: ancestorChainRecords exceeded max depth (${MAX_COLLECTION_DEPTH})`);
}

// Root-first name segments from root down to (and including) this collection - the inverse walk of
// resolveCollectionByNames, used to build display URLs and audit "collection" labels.
export async function collectionPath(id: string): Promise<string[]> {
  return (await ancestorChainRecords(id)).map((record) => record.name);
}

// D-96: root-first OWN protection levels from root down to (and including) this collection.
// `resolveEffective` (storage/files.ts) folds this together with a file's own stored level via
// lib/protection.ts's mostRestrictive() to get the file's EFFECTIVE protection - the only level any read
// path may act on.
export async function protectionChain(id: string): Promise<Protection[]> {
  return (await ancestorChainRecords(id)).map((record) => record.protection);
}

// D-102/§1.4 of the E4 waves hand-off: root-first {id, name, linkToken} triples for the browse API's
// breadcrumb, empty at root. `linkToken` (E4.1 Wave C) is what lets the caller build each ancestor's OWN
// previewUrl (buildCollectionPreviewUrl) without the client ever constructing a URL itself (D-100) - a
// breadcrumb crumb needs to be a REAL clickable link, not just a label.
// `ownerSub` (E4.1 Wave C) is what lets the caller decide, per ancestor, whether THIS SPECIFIC crumb's
// own token is safe to hand back - see controllers/browse.ts's breadcrumb construction: being authorized
// on the deeper TARGET does not imply authorization on every ancestor above it (an ACL grant can be
// scoped to one nested collection with none on its parent).
export async function collectionBreadcrumb(
  id: string,
): Promise<{ id: string; name: string; linkToken: string; ownerSub: string }[]> {
  return (await ancestorChainRecords(id)).map((record) => ({
    id: record.id,
    name: record.name,
    linkToken: record.linkToken,
    ownerSub: record.ownerSub,
  }));
}

export async function listCollectionsFor(sub: string): Promise<CollectionRecord[]> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE owner_sub = ? ORDER BY created_at ASC`,
    [sub],
  );
  return rows.map(rowToRecord);
}

// --- Browse listing queries (§1.4 of the E4 waves hand-off) - one per scope, newest-first ------------
//
// Each returns the direct children of `parentId` ('' for root). None of these resolve EFFECTIVE
// protection - that is controllers/browse.ts's job (it already has each row's OWN protection to fold
// with the parent chain the caller separately verified). The public-scope query is the security-critical
// one: it is a single WHERE clause that structurally cannot return a non-public row, never a broader
// select filtered in JavaScript afterward - see controllers/browse.ts for why checking each row's own
// `protection` here is sufficient (the caller has already verified the parent chain is itself public).

export async function listOwnedChildCollections(parentId: string, ownerSub: string): Promise<CollectionRecord[]> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE parent_id = ? AND owner_sub = ? ORDER BY created_at DESC`,
    [parentId, ownerSub],
  );
  return rows.map(rowToRecord);
}

export async function listPublicChildCollections(parentId: string): Promise<CollectionRecord[]> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE parent_id = ? AND protection = 'public' ORDER BY created_at DESC`,
    [parentId],
  );
  return rows.map(rowToRecord);
}

export async function listAllChildCollections(parentId: string): Promise<CollectionRecord[]> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE parent_id = ? ORDER BY created_at DESC`,
    [parentId],
  );
  return rows.map(rowToRecord);
}

function isSiblingNameDuplicate(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ER_DUP_ENTRY" &&
    /uniq_sibling_name/.test((err as { message?: string }).message ?? "")
  );
}

// D-105: a new collection inherits its parent's protection (`unlisted` at root, matching the column
// default) - the caller (controllers/manage.ts) resolves the parent's own `protection` and passes it
// through; this function does not walk the parent chain itself.
export async function createCollection(params: {
  parentId: string;
  name: string;
  ownerSub: string;
  protection?: Protection;
}): Promise<CollectionRecord> {
  const id = generateId();
  const protection = params.protection ?? "unlisted";
  const linkToken = await mintUniqueToken((candidate) => isLinkTokenTaken(getPool(), candidate));
  await getPool().query(
    "INSERT INTO collections (id, parent_id, name, owner_sub, protection, default_protection, link_token) VALUES (?, ?, ?, ?, ?, 'unlisted', ?)",
    [id, params.parentId, params.name, params.ownerSub, protection, linkToken],
  );
  const record = await resolveCollectionById(id);
  if (record === null) throw new Error("storage/collections: createCollection - row vanished after insert");
  return record;
}

// The user's own root-level default collection, created once and reused after. A root-level name is
// unique across ALL owners (uniq_sibling_name has no owner column), so two different subs asking for the
// same default name can no longer be silently comingled into one shared collection the way two users
// sharing a `name` claim shared a disk folder pre-E3 - the second one lands in a distinctly-suffixed
// collection of their own instead.
export async function ensureDefaultCollection(sub: string, name: string): Promise<CollectionRecord> {
  const [ownRows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE parent_id = '' AND owner_sub = ? AND name = ?`,
    [sub, name],
  );
  const existing = ownRows[0];
  if (existing !== undefined) return rowToRecord(existing);

  let candidate = name;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await createCollection({ parentId: "", name: candidate, ownerSub: sub });
    } catch (err) {
      if (!isSiblingNameDuplicate(err)) throw err;
      candidate = `${name}-${attempt + 2}`; // name, then name-2, name-3, ... on each further collision
    }
  }
  throw new Error(`storage/collections: could not find a free default-collection name for "${name}"`);
}

export async function renameCollection(id: string, newName: string): Promise<void> {
  await getPool().query("UPDATE collections SET name = ? WHERE id = ?", [newName, id]);
}

// D-86: a collection's default_protection is what new uploads into it inherit (upload.ts, Wave E).
export async function setCollectionDefaultProtection(id: string, protection: Protection): Promise<void> {
  await getPool().query("UPDATE collections SET default_protection = ? WHERE id = ?", [protection, id]);
}

// D-95: a collection's OWN protection - distinct from default_protection above. D-97's write-time floor
// is enforced by the caller (controllers/manage.ts's assertNotBelowParent) before this is ever called;
// this function itself is a plain, unconditional write, same shape as setCollectionDefaultProtection.
export async function setCollectionProtection(id: string, protection: Protection): Promise<void> {
  await getPool().query("UPDATE collections SET protection = ? WHERE id = ?", [protection, id]);
}

async function descendantCollectionIds(rootId: string): Promise<string[]> {
  const all: string[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    all.push(...frontier);
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT id FROM collections WHERE parent_id IN (${frontier.map(() => "?").join(",")})`,
      frontier,
    );
    frontier = (rows as { id: string }[]).map((row) => row.id);
  }
  return all;
}

// D-88/D-104: the count a recursive-delete confirmation names, computed WITHOUT deleting anything -
// shares descendantCollectionIds with deleteCollectionRecursive below so the two can never disagree on
// what "descendant" means. `collectionCount` includes the collection itself (matching what deleting it
// actually removes), so a leaf collection with no children reports 1, not 0.
export async function countDescendants(id: string): Promise<{ collectionCount: number; fileCount: number }> {
  const collectionIds = await descendantCollectionIds(id);
  const [fileRows] = await getPool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM files WHERE collection_id IN (${collectionIds.map(() => "?").join(",")})`,
    collectionIds,
  );
  const fileCount = Number((fileRows as { count: number }[])[0]?.count ?? 0);
  return { collectionCount: collectionIds.length, fileCount };
}

// D-88: deleting a collection recursively deletes every descendant collection, file row and file's
// bytes. One audit line per file is the CALLER's responsibility (controllers/manage.ts), which is why
// this returns the deleted file ids rather than emitting audit events itself - storage stays I/O-free of
// anything but MariaDB/the filesystem (technical-baseline.md §2).
export async function deleteCollectionRecursive(
  id: string,
): Promise<{ deletedFileIds: string[] }> {
  const collectionIds = await descendantCollectionIds(id);
  const [fileRows] = await getPool().query<RowDataPacket[]>(
    `SELECT id FROM files WHERE collection_id IN (${collectionIds.map(() => "?").join(",")})`,
    collectionIds,
  );
  const fileIds = (fileRows as { id: string }[]).map((row) => row.id);

  for (const fileId of fileIds) {
    await deleteFile(fileId);
  }
  // Deepest-first, even though there is no declared FK to enforce ordering today - keeps this correct if
  // one is ever added.
  for (const collectionId of [...collectionIds].reverse()) {
    await getPool().query("DELETE FROM collection_acl WHERE collection_id = ?", [collectionId]);
    await getPool().query("DELETE FROM collections WHERE id = ?", [collectionId]);
  }
  return { deletedFileIds: fileIds };
}

// One level only: is there a collection_acl row for exactly this collection? Security invariant 6: the sub
// is matched byte-for-byte by a plain equality clause, never parsed. Exported because a listing needs the
// per-row check on its own, separately from the ancestor walk below - every row on one browse page shares
// the same ancestors, so walking the chain again per row is pure repeated work (controllers/browse.ts).
export async function hasCollectionAclGrant(collectionId: string, sub: string): Promise<boolean> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT 1 FROM collection_acl WHERE collection_id = ? AND sub = ? LIMIT 1",
    [collectionId, sub],
  );
  return rows.length > 0;
}

// D-99: authorized identity for a restrictive collection's contents includes an ACL grant on ANY
// ancestor collection, not only the one immediately holding the object - a grant on a top-level
// collection must pierce down to everything nested beneath it. Walks the same chain protectionChain
// does, checking collection_acl at each level in turn (root check happens last since the walk climbs
// from the given collection upward), returning true on the first match.
export async function hasAclGrantOnChain(collectionId: string, sub: string): Promise<boolean> {
  let currentId = collectionId;
  for (let depth = 0; depth < MAX_COLLECTION_DEPTH; depth++) {
    if (await hasCollectionAclGrant(currentId, sub)) return true;
    const record = await resolveCollectionById(currentId);
    if (record === null) {
      throw new Error(`storage/collections: hasAclGrantOnChain - dangling parent_id "${currentId}"`);
    }
    if (record.parentId === "") return false;
    currentId = record.parentId;
  }
  throw new Error(`storage/collections: hasAclGrantOnChain exceeded max depth (${MAX_COLLECTION_DEPTH})`);
}

// D-87: the structure lands in E3 (this table + this read) so multiple users can hold upload rights on a
// collection; nothing in E3 writes a collection_acl row - E7 owns the granting UI.
export async function canUploadTo(collection: CollectionRecord, claims: Claims): Promise<boolean> {
  if (claims.sub === collection.ownerSub) return true;
  if (isSuperuser(claims)) return true;
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT 1 FROM collection_acl WHERE collection_id = ? AND sub = ? AND can_upload = 1 LIMIT 1",
    [collection.id, claims.sub],
  );
  return rows.length > 0;
}
