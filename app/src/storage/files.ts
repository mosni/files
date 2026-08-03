// The only module that maps files between the database and the disk (besides storage/collections.ts,
// which owns `collections`/`collection_acl` and calls back into this module's deleteFile for a recursive
// collection delete). D-81: a file's identity is a surrogate id, not a path - the disk layout
// (`<diskDir>/<diskName>`, fixed at ingest) is an internal detail this module alone assembles. There is
// still NO reconciliation - a row exists only because an upload claimed it (D-85), and a lookup queries
// the row and stats the one disk path it names; it never scans a directory or indexes a file it happens
// to find on disk.

import { stat, unlink } from "node:fs/promises";
import type { RowDataPacket } from "mysql2/promise";
import { resolveRelPath, suffixForCollision } from "../lib/paths.ts";
import { mostRestrictive, type Protection } from "../lib/protection.ts";
import { mintUniqueToken } from "../lib/tokens.ts";
import { generateId } from "../lib/ids.ts";
import { protectionChain, resolveCollectionByNames } from "./collections.ts";
import { getPool, isLinkTokenTaken } from "./db.ts";

export type FileRecord = {
  id: string;
  collectionId: string;
  name: string; // display name; renameable (D-82)
  diskDir: string; // "YYYY/mm", fixed at ingest, never changes
  diskName: string; // "<id>-<original filename>", fixed at ingest, never changes
  bytes: number;
  protection: Protection;
  linkToken: string;
  ownerSub: string | null;
  uploaderSub: string | null;
  createdAt: string; // ISO 8601
  width: number | null; // image or video pixel width, captured at ingest
  height: number | null;
  durationSeconds: number | null; // video only
  textPreview: string | null; // .txt only
  uploaderName: string | null; // display name from claims.name at upload (D-136). NEVER the sub (D-92).
  thumbName: string | null; // bare filename within diskDir, or null (non-image / generation failed / pre-E5, D-137)
};

let storageRoot: string | undefined;

export function initFilesStorage(root: string): void {
  storageRoot = root;
}

function getStorageRoot(): string {
  if (storageRoot === undefined) {
    throw new Error("storage/files: initFilesStorage() must be called before use");
  }
  return storageRoot;
}

// The relative path handed to X-Accel-Redirect - the ONLY place disk layout is assembled.
export function diskRelPath(record: Pick<FileRecord, "diskDir" | "diskName">): string {
  return `${record.diskDir}/${record.diskName}`;
}

// D-137: the thumbnail's own relative disk path, alongside diskRelPath() for the source - null when no
// thumbnail exists (non-image/video, generation failed, or a pre-E5 row). `thumb_name` is bare and lives
// in the SAME directory as the source (migration 004), so this is the second (and only other) disk-path
// assembly point besides diskRelPath().
export function thumbRelPath(record: Pick<FileRecord, "diskDir" | "thumbName">): string | null {
  return record.thumbName === null ? null : `${record.diskDir}/${record.thumbName}`;
}

// D-82's "<YYYY>/<mm>" ingest-time disk directory, fixed forever once a file claims it. Pure and
// I/O-free, so upload.ts's ingest date can be exercised with a fixed `now` under test.
export function currentDiskDir(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

interface FileRow extends RowDataPacket {
  id: string;
  collection_id: string;
  name: string;
  disk_dir: string;
  disk_name: string;
  bytes: number;
  protection: Protection;
  link_token: string;
  state: "pending" | "committed";
  owner_sub: string | null;
  uploader_sub: string | null;
  created_at: Date;
  width: number | null;
  height: number | null;
  duration_seconds: string | null; // mysql2 returns DECIMAL as a string
  text_preview: string | null;
  uploader_name: string | null;
  thumb_name: string | null;
}

const SELECT_COLUMNS =
  "id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub, uploader_sub, created_at, width, height, duration_seconds, text_preview, uploader_name, thumb_name";

function rowToRecord(row: FileRow, bytes: number): FileRecord {
  return {
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    diskDir: row.disk_dir,
    diskName: row.disk_name,
    bytes,
    protection: row.protection,
    linkToken: row.link_token,
    ownerSub: row.owner_sub,
    uploaderSub: row.uploader_sub,
    createdAt: row.created_at.toISOString(),
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    textPreview: row.text_preview,
    uploaderName: row.uploader_name,
    thumbName: row.thumb_name,
  };
}

export async function deleteFileRow(id: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM file_acl WHERE file_id = ?", [id]);
  await pool.query("DELETE FROM files WHERE id = ?", [id]);
}

// Applies the D-85 "pending rows are exempt" rule and the D-16 vanished-bytes prune uniformly to every
// row-level lookup (by names, by token, or by id). A `pending` row's bytes are legitimately not on disk
// yet, so it is treated exactly like "no row" rather than pruned.
async function materialize(row: FileRow): Promise<FileRecord | null> {
  if (row.state === "pending") return null;

  const root = getStorageRoot();
  const absolutePath = resolveRelPath(root, diskRelPath({ diskDir: row.disk_dir, diskName: row.disk_name }));
  const entryStat = absolutePath === null ? null : await stat(absolutePath).catch(() => null);
  if (entryStat === null) {
    await deleteFileRow(row.id);
    return null;
  }
  return rowToRecord(row, entryStat.size);
}

// Resolution for `/f/<...>` (replaces the old path-keyed resolveByPath). `segments` is the decoded URL
// path: zero or more collection names followed by the file name. Walks collections from root, then the
// file by (collection_id, name). D-126 (E4.1 live-testing findings, Wave A3): a single-segment path is a
// bare root-level filename - `resolveCollectionByNames([])` returns null by contract (root is not a
// collection row), so that lookup is skipped entirely rather than treated as a failed resolution.
export async function resolveByNames(segments: readonly string[]): Promise<FileRecord | null> {
  if (segments.length < 1) return null;
  const collectionSegments = segments.slice(0, -1);
  const fileName = segments[segments.length - 1]!;

  let collectionId = "";
  if (collectionSegments.length > 0) {
    const collection = await resolveCollectionByNames(collectionSegments);
    if (collection === null) return null;
    collectionId = collection.id;
  }

  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files WHERE collection_id = ? AND name = ?`,
    [collectionId, fileName],
  );
  const row = rows[0];
  return row === undefined ? null : await materialize(row);
}

export async function resolveByToken(token: string): Promise<FileRecord | null> {
  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files WHERE link_token = ?`,
    [token],
  );
  const row = rows[0];
  return row === undefined ? null : await materialize(row);
}

export async function resolveById(id: string): Promise<FileRecord | null> {
  const [rows] = await getPool().query<FileRow[]>(`SELECT ${SELECT_COLUMNS} FROM files WHERE id = ?`, [id]);
  const row = rows[0];
  return row === undefined ? null : await materialize(row);
}

// D-96: a FileRecord plus its resolved EFFECTIVE protection - the most restrictive level along its
// collection's ancestor chain, then the file's own stored level. This is the landmine
// (technical-baseline.md §3): `record.protection` alone is never safe to read on any read path, because
// D-97 deliberately leaves it looser than an ancestor collection after that collection is raised. Every
// read path (delivery, preview, fileUrls callers, the browse API) must resolve this and act on
// `effectiveProtection`, never `protection` directly.
export type ResolvedFile = FileRecord & { effectiveProtection: Protection };

export async function resolveEffective(record: FileRecord): Promise<ResolvedFile> {
  const chain = await protectionChain(record.collectionId);
  const effectiveProtection = mostRestrictive([...chain, record.protection]);
  return { ...record, effectiveProtection };
}

// --- Browse listing queries (D-116/§1.2 of the E4.1 Wave E findings hand-off) - one per scope, newest-
// first ------------------------------------------------------------------------------------------------
//
// Each returns committed files directly inside `collectionId`. `state='committed'` excludes D-85 pending
// rows exactly like every other lookup in this module - a listing must not surface an upload still in
// flight. None of these resolve EFFECTIVE protection or stat() the filesystem; controllers/browse.ts
// folds each row's own protection with the parent chain it already verified, and a listing is not the
// place to pay for a stat() per row (D-16's vanished-bytes prune already happens lazily on individual
// lookups). listVisibleFilesIn's anonymous branch is the security-critical one - see
// storage/collections.ts's matching comment for why filtering by protection = 'public' here is
// sufficient given the caller's prior check.

function rowToListedRecord(row: FileRow): FileRecord {
  return rowToRecord(row, row.bytes);
}

export async function listOwnedFilesIn(collectionId: string, ownerSub: string): Promise<FileRecord[]> {
  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files WHERE collection_id = ? AND owner_sub = ? AND state = 'committed' ORDER BY created_at DESC`,
    [collectionId, ownerSub],
  );
  return rows.map(rowToListedRecord);
}

// D-116/§1.2 of the E4.1 Wave E findings hand-off: the `visible` scope's one query, replacing the old
// scope=public/scope=all split. Two EXPLICIT SQL branches, never one NULL-guarded predicate - see
// storage/collections.ts's listVisibleChildCollections for why that matters.
export async function listVisibleFilesIn(collectionId: string, viewerSub: string | null): Promise<FileRecord[]> {
  if (viewerSub === null) {
    const [rows] = await getPool().query<FileRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM files WHERE collection_id = ? AND protection = 'public' AND state = 'committed' ORDER BY created_at DESC`,
      [collectionId],
    );
    return rows.map(rowToListedRecord);
  }
  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files
     WHERE collection_id = ? AND state = 'committed'
       AND (
         protection = 'public'
         OR owner_sub = ?
         OR EXISTS (SELECT 1 FROM file_acl WHERE file_acl.file_id = files.id AND file_acl.sub = ?)
       )
     ORDER BY created_at DESC`,
    [collectionId, viewerSub, viewerSub],
  );
  return rows.map(rowToListedRecord);
}

// D-125 (E4.1 live-testing findings, Wave B): the third breadth - a viewer who holds this collection's own
// link (token or readable path, D-124) but is not independently authorized on it sees its `public`/
// `unlisted` files PLUS anything they are independently authorized on (own, or a file_acl grant); never a
// `secret`/`private` row. Same two-explicit-branches shape as listVisibleFilesIn, for the same reason.
export async function listLinkAuthorizedFilesIn(collectionId: string, viewerSub: string | null): Promise<FileRecord[]> {
  if (viewerSub === null) {
    const [rows] = await getPool().query<FileRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM files WHERE collection_id = ? AND protection IN ('public','unlisted') AND state = 'committed' ORDER BY created_at DESC`,
      [collectionId],
    );
    return rows.map(rowToListedRecord);
  }
  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files
     WHERE collection_id = ? AND state = 'committed'
       AND (
         protection IN ('public','unlisted')
         OR owner_sub = ?
         OR EXISTS (SELECT 1 FROM file_acl WHERE file_acl.file_id = files.id AND file_acl.sub = ?)
       )
     ORDER BY created_at DESC`,
    [collectionId, viewerSub, viewerSub],
  );
  return rows.map(rowToListedRecord);
}

export async function listAllFilesIn(collectionId: string): Promise<FileRecord[]> {
  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files WHERE collection_id = ? AND state = 'committed' ORDER BY created_at DESC`,
    [collectionId],
  );
  return rows.map(rowToListedRecord);
}

// Security invariant 6: sub is matched byte-for-byte, never parsed - a plain equality WHERE clause is
// exactly that. Used by the delivery/preview controllers to authorize `private` access for a
// non-owner/non-superuser.
export async function hasAclGrant(fileId: string, sub: string): Promise<boolean> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT 1 FROM file_acl WHERE file_id = ? AND sub = ? LIMIT 1",
    [fileId, sub],
  );
  return rows.length > 0;
}

function isDuplicateOf(err: unknown, pattern: RegExp): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ER_DUP_ENTRY" &&
    pattern.test((err as { message?: string }).message ?? "")
  );
}

// D-85, phase 1: claim a `pending` row (fresh id, disk location decided, but bytes not moved into place
// yet) before anything touches the filesystem. `bytes` starts at 0 and is meaningless until commitFileRow
// - pending rows are never returned by any lookup above, so nobody can observe the placeholder value.
//
// Display-name collisions are resolved HERE rather than by the caller, because the INSERT is the only
// point that can actually detect one. A caller that read the sibling names first and suffixed against
// that list is racing: two concurrent uploads of the same filename both read the same list, both pick the
// same name, and the second one's INSERT dies on uniq_name_in_collection (AC11 requires it to succeed as a
// second, distinct file). Retrying against a freshly-read list closes that window - `name` is therefore a
// REQUESTED name, and the returned record's `name` is the one actually taken.
export async function claimFileRow(params: {
  // Optional: lets a caller that needs the id BEFORE this call returns (upload.ts builds diskName as
  // "<id>-<originalFilename>", so it must know the id up front) generate it with lib/ids.ts's
  // generateId() and pass it through, guaranteeing the row's primary key and its disk_name always agree.
  // Omit it (tests, mostly) and one is generated internally.
  id?: string;
  collectionId: string;
  name: string;
  diskDir: string;
  diskName: string;
  ownerSub: string;
  uploaderSub: string;
  protection: Protection;
  uploaderName: string | null; // D-136: claims.name at upload time, captured now since it never changes
  // after the strip/probe/thumbnail pass. NEVER the sub (D-92).
}): Promise<FileRecord> {
  const pool = getPool();
  const id = params.id ?? generateId();
  // The requested name is only re-suffixed after a collision actually happens, so a name with no
  // conflict is stored exactly as asked for.
  let name = params.name;
  for (let attempt = 0; attempt < 10; attempt++) {
    // D-98: the token namespace is shared with collections, which has its own independent unique index -
    // a files-table collision alone can no longer be trusted to catch every clash, so check both tables
    // up front rather than relying solely on the reactive catch below.
    const linkToken = await mintUniqueToken((candidate) => isLinkTokenTaken(pool, candidate));
    const createdAt = new Date();
    try {
      await pool.query(
        `INSERT INTO files
          (id, collection_id, name, disk_dir, disk_name, bytes, protection, link_token, state, owner_sub, uploader_sub, created_at, uploader_name)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?, ?)`,
        [
          id,
          params.collectionId,
          name,
          params.diskDir,
          params.diskName,
          params.protection,
          linkToken,
          params.ownerSub,
          params.uploaderSub,
          createdAt,
          params.uploaderName,
        ],
      );
      return {
        id,
        collectionId: params.collectionId,
        name,
        diskDir: params.diskDir,
        diskName: params.diskName,
        bytes: 0,
        protection: params.protection,
        linkToken,
        ownerSub: params.ownerSub,
        uploaderSub: params.uploaderSub,
        createdAt: createdAt.toISOString(),
        width: null,
        height: null,
        durationSeconds: null,
        textPreview: null,
        uploaderName: params.uploaderName,
        thumbName: null,
      };
    } catch (err) {
      if (isDuplicateOf(err, /link_token|uniq_link_token/)) continue; // regenerate the token and retry
      if (isDuplicateOf(err, /uniq_name_in_collection/)) {
        // Always re-suffix from the ORIGINAL requested name against a freshly-read sibling list, never
        // from the previous candidate - suffixing "dup(2).txt" again would produce "dup(2)(2).txt".
        name = suffixForCollision(params.name, await listNamesInCollection(params.collectionId));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`storage/files: could not claim a row for "${params.name}" after 10 attempts`);
}

// D-85, phase 2: the bytes are already at their final disk location (the caller moved them) by the time
// this is called - flips the row to `committed`, at which point every lookup above can find it.
export async function commitFileRow(
  id: string,
  params: {
    bytes: number;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    textPreview: string | null;
    thumbName: string | null; // D-137: null for a non-image, a generation failure, or a pre-E5 file
  },
): Promise<FileRecord> {
  await getPool().query(
    `UPDATE files SET bytes = ?, width = ?, height = ?, duration_seconds = ?, text_preview = ?, thumb_name = ?, state = 'committed'
     WHERE id = ?`,
    [params.bytes, params.width, params.height, params.durationSeconds, params.textPreview, params.thumbName, id],
  );
  const [rows] = await getPool().query<FileRow[]>(`SELECT ${SELECT_COLUMNS} FROM files WHERE id = ?`, [id]);
  const row = rows[0];
  if (row === undefined) throw new Error(`storage/files: commitFileRow - row "${id}" vanished`);
  return rowToRecord(row, params.bytes);
}

// D-85: undoes claimFileRow when anything between claim and commit fails. Only removes the DB row - the
// caller is responsible for unlinking whatever bytes it may have already moved (see controllers/upload.ts),
// since this module never assumes where in that sequence the failure happened.
export async function abandonFileRow(id: string): Promise<void> {
  await deleteFileRow(id);
}

// Display names already taken within a collection - what claimFileRow's collision retry suffixes against.
// This deliberately includes `pending` rows: uniq_name_in_collection constrains every row regardless of
// state, so a list that skipped pending names would keep proposing a name an in-flight upload already
// holds and the retry would never converge. A pending name is released again by abandonFileRow if that
// upload fails.
export async function listNamesInCollection(collectionId: string): Promise<string[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT name FROM files WHERE collection_id = ?",
    [collectionId],
  );
  return (rows as { name: string }[]).map((row) => row.name);
}

export async function renameFile(id: string, newName: string): Promise<void> {
  await getPool().query("UPDATE files SET name = ? WHERE id = ?", [newName, id]);
}

export async function setFileProtection(id: string, protection: Protection): Promise<void> {
  await getPool().query("UPDATE files SET protection = ? WHERE id = ?", [protection, id]);
}

// D-82/D-130 (E4.1 live-testing findings, Wave C): a move is a plain UPDATE of collection_id - disk_dir/
// disk_name are fixed at ingest and are never touched here; no bytes move. The caller (controllers/
// manage.ts) is responsible for authorization, destination validity and the D-97 floor before calling
// this.
export async function moveFile(id: string, collectionId: string): Promise<void> {
  await getPool().query("UPDATE files SET collection_id = ? WHERE id = ?", [collectionId, id]);
}

// D-16: a hard delete removes the row, its ACL rows, AND the bytes. Row first, then bytes (A4) - a crash
// mid-way leaves orphaned bytes rather than a row pointing at nothing, the safer of the two failure modes
// since orphaned bytes are simply inert (D-16: an unindexed file is never served).
export async function deleteFile(id: string): Promise<void> {
  const [rows] = await getPool().query<FileRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM files WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return; // already gone - idempotent

  await deleteFileRow(id);

  const root = getStorageRoot();
  const absolutePath = resolveRelPath(root, diskRelPath({ diskDir: row.disk_dir, diskName: row.disk_name }));
  if (absolutePath !== null) {
    await unlink(absolutePath).catch(() => {});
  }

  // D-137 (E5): the thumbnail is a SECOND on-disk artifact per file, so a hard delete has to remove it
  // too - otherwise every deleted image/video leaves an orphaned `<id>-thumb.webp` behind forever, and
  // "a hard delete removes the row, its ACL rows, AND the bytes" (D-16) quietly stops being true. Not a
  // serving leak (with the row gone nothing can ever hand nginx an X-Accel-Redirect for it, D-16), but it
  // is unbounded dead disk on a box that has little to spare. Added in review session 034.
  const thumbRel = thumbRelPath({ diskDir: row.disk_dir, thumbName: row.thumb_name });
  if (thumbRel !== null) {
    const thumbAbsolutePath = resolveRelPath(root, thumbRel);
    if (thumbAbsolutePath !== null) {
      await unlink(thumbAbsolutePath).catch(() => {});
    }
  }
}
