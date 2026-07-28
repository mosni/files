// D-80: collections are real, nested DB entities - never called "folders" (Hannah's explicit
// terminology call). This is the only module that queries the `collections`/`collection_acl` tables;
// storage/files.ts stays the only module that queries `files`/`file_acl` and touches the filesystem, but
// recursive collection delete needs both, so it lives here and calls into files.ts's per-file deleteFile.

import type { RowDataPacket } from "mysql2/promise";
import type { Claims } from "../lib/roles.ts";
import { isSuperuser } from "../lib/roles.ts";
import { generateId } from "../lib/ids.ts";
import type { Protection } from "../lib/protection.ts";
import { deleteFile } from "./files.ts";
import { getPool } from "./db.ts";

export type CollectionRecord = {
  id: string;
  parentId: string;
  name: string;
  ownerSub: string;
  defaultProtection: Protection;
  createdAt: string;
};

interface CollectionRow extends RowDataPacket {
  id: string;
  parent_id: string;
  name: string;
  owner_sub: string;
  default_protection: Protection;
  created_at: Date;
}

function rowToRecord(row: CollectionRow): CollectionRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    ownerSub: row.owner_sub,
    defaultProtection: row.default_protection,
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT_COLUMNS =
  "id, parent_id, name, owner_sub, default_protection, created_at";

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

// Root-first name segments from root down to (and including) this collection - the inverse walk of
// resolveCollectionByNames, used to build display URLs and audit "collection" labels.
export async function collectionPath(id: string): Promise<string[]> {
  const names: string[] = [];
  let currentId = id;
  for (let depth = 0; depth < MAX_COLLECTION_DEPTH; depth++) {
    const record = await resolveCollectionById(currentId);
    if (record === null) {
      throw new Error(`storage/collections: collectionPath - dangling parent_id "${currentId}"`);
    }
    names.unshift(record.name);
    if (record.parentId === "") return names;
    currentId = record.parentId;
  }
  throw new Error(`storage/collections: collectionPath exceeded max depth (${MAX_COLLECTION_DEPTH})`);
}

export async function listCollectionsFor(sub: string): Promise<CollectionRecord[]> {
  const [rows] = await getPool().query<CollectionRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM collections WHERE owner_sub = ? ORDER BY created_at ASC`,
    [sub],
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

export async function createCollection(params: {
  parentId: string;
  name: string;
  ownerSub: string;
}): Promise<CollectionRecord> {
  const id = generateId();
  await getPool().query(
    "INSERT INTO collections (id, parent_id, name, owner_sub, default_protection) VALUES (?, ?, ?, ?, 'unlisted')",
    [id, params.parentId, params.name, params.ownerSub],
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
