// D-56/D-57: the ONLY module that walks the storage tree. Reconciliation is lazy and request-scoped -
// there is no background scan and no watcher. Listing a collection reads exactly that one directory;
// resolving a download stats exactly that one path. Never readdir recursively.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { isIgnoredEntry, resolveStoragePath } from "../lib/paths.ts";
import type { Protection } from "../lib/protection.ts";
import { generateLinkToken } from "../lib/tokens.ts";
import { getOrCreateCollectionForDiskEntry, type CollectionRecord } from "./collections.ts";
import { getPool } from "./db.ts";
import { stripInPlace } from "./strip.ts";

export type FileRecord = {
  collection: string;
  name: string;
  bytes: number;
  protection: Protection;
  linkToken: string;
  ownerSub: string | null;
  uploaderSub: string | null;
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

interface FileRow extends RowDataPacket {
  collection_id: string;
  display_name: string;
  bytes: number;
  protection: Protection;
  link_token: string;
  uploader_sub: string | null;
}

async function deleteFileRow(collectionId: string, displayName: string): Promise<void> {
  const pool = getPool();
  // file_acl has no ON DELETE CASCADE (matches the pre-existing schema convention) - clean it up
  // explicitly, before the parent row, in FK-safe order.
  await pool.query("DELETE FROM file_acl WHERE collection_id = ? AND display_name = ?", [
    collectionId,
    displayName,
  ]);
  await pool.query("DELETE FROM files WHERE collection_id = ? AND display_name = ?", [
    collectionId,
    displayName,
  ]);
}

// Inserts a row for a disk entry with no matching row yet (a hand-copied drop-in, D-56), then strips it.
// On strip failure the just-inserted row is rolled back and this returns null - the caller must treat the
// file as unservable rather than serve an unstripped original (D-60); the next reconcile simply retries.
async function reconcileNewEntry(
  collection: CollectionRecord,
  displayName: string,
  absolutePath: string,
  bytes: number,
): Promise<FileRecord | null> {
  const linkToken = generateLinkToken();
  await getPool().query(
    "INSERT INTO files (collection_id, display_name, bytes, protection, link_token, uploader_sub) VALUES (?, ?, ?, ?, ?, NULL)",
    [collection.id, displayName, bytes, collection.protection, linkToken],
  );

  try {
    await stripInPlace(absolutePath);
  } catch (err) {
    console.error(`storage/files: stripInPlace failed for ${absolutePath} - excluding from listing`, err);
    await deleteFileRow(collection.id, displayName);
    return null;
  }

  return {
    collection: collection.name,
    name: displayName,
    bytes,
    protection: collection.protection,
    linkToken,
    ownerSub: collection.ownerSub,
    uploaderSub: null,
  };
}

function rowToRecord(collection: CollectionRecord, row: FileRow, bytes: number): FileRecord {
  return {
    collection: collection.name,
    name: row.display_name,
    bytes,
    protection: row.protection,
    linkToken: row.link_token,
    ownerSub: collection.ownerSub,
    uploaderSub: row.uploader_sub,
  };
}

export async function listCollection(collectionName: string): Promise<FileRecord[]> {
  const root = getStorageRoot();
  const collection = await getOrCreateCollectionForDiskEntry(root, collectionName);
  if (collection === null) return [];

  const dirPath = path.join(root, collectionName);
  const dirents = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const diskNames = new Set(
    dirents.filter((entry) => entry.isFile() && !isIgnoredEntry(entry.name)).map((entry) => entry.name),
  );

  const [rows] = await getPool().query<FileRow[]>(
    "SELECT collection_id, display_name, bytes, protection, link_token, uploader_sub FROM files WHERE collection_id = ?",
    [collection.id],
  );

  // Row with no entry on disk -> delete it (D-56/D-57: the filesystem is the truth).
  for (const row of rows) {
    if (!diskNames.has(row.display_name)) {
      await deleteFileRow(collection.id, row.display_name);
    }
  }
  const rowsByName = new Map(
    rows.filter((row) => diskNames.has(row.display_name)).map((row) => [row.display_name, row]),
  );

  const records: FileRecord[] = [];
  for (const name of diskNames) {
    const absolutePath = path.join(dirPath, name);
    const entryStat = await stat(absolutePath).catch(() => null);
    if (entryStat === null) continue; // vanished between readdir and stat - next call reconciles

    const existingRow = rowsByName.get(name);
    if (existingRow !== undefined) {
      records.push(rowToRecord(collection, existingRow, entryStat.size));
    } else {
      const record = await reconcileNewEntry(collection, name, absolutePath, entryStat.size);
      if (record !== null) records.push(record);
    }
  }

  return records;
}

export async function resolveByPath(collectionName: string, name: string): Promise<FileRecord | null> {
  const root = getStorageRoot();
  const collection = await getOrCreateCollectionForDiskEntry(root, collectionName);
  if (collection === null) return null;

  const absolutePath = resolveStoragePath(root, collectionName, name);
  if (absolutePath === null) return null;

  const entryStat = await stat(absolutePath).catch(() => null);
  if (entryStat === null) return null;

  const [rows] = await getPool().query<FileRow[]>(
    "SELECT collection_id, display_name, bytes, protection, link_token, uploader_sub FROM files WHERE collection_id = ? AND display_name = ?",
    [collection.id, name],
  );
  const existingRow = rows[0];
  if (existingRow !== undefined) {
    return rowToRecord(collection, existingRow, entryStat.size);
  }

  return reconcileNewEntry(collection, name, absolutePath, entryStat.size);
}

interface FileWithCollectionRow extends FileRow {
  collection_name: string;
  collection_owner_sub: string | null;
}

export async function resolveByToken(token: string): Promise<FileRecord | null> {
  const root = getStorageRoot();
  const [rows] = await getPool().query<FileWithCollectionRow[]>(
    `SELECT files.collection_id, files.display_name, files.bytes, files.protection, files.link_token,
            files.uploader_sub, collections.name AS collection_name, collections.owner_sub AS collection_owner_sub
     FROM files JOIN collections ON files.collection_id = collections.id
     WHERE files.link_token = ?`,
    [token],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const absolutePath = resolveStoragePath(root, row.collection_name, row.display_name);
  const entryStat = absolutePath === null ? null : await stat(absolutePath).catch(() => null);
  if (entryStat === null) {
    // D-16: a dead link 404s. The file is gone - clean up the row rather than serving a ghost record.
    await deleteFileRow(row.collection_id, row.display_name);
    return null;
  }

  return {
    collection: row.collection_name,
    name: row.display_name,
    bytes: entryStat.size,
    protection: row.protection,
    linkToken: row.link_token,
    ownerSub: row.collection_owner_sub,
    uploaderSub: row.uploader_sub,
  };
}
