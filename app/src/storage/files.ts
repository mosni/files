// The only module that maps files between the database and the disk. Preliminary-review P7: there is NO
// reconciliation - a `files` row exists only because an upload created it. A lookup queries the row and
// stats the one path it names; it never scans a directory and never inserts a row for a file it happens to
// find on disk (no drop-in). "Keep the filesystem intact" still holds: bytes live at their real mirrored
// paths; they are just indexed by the DB rather than discovered by walking.

import { stat, unlink } from "node:fs/promises";
import type { RowDataPacket } from "mysql2/promise";
import { resolveRelPath, safeRelPath } from "../lib/paths.ts";
import type { Protection } from "../lib/protection.ts";
import { generateLinkToken } from "../lib/tokens.ts";
import { getPool } from "./db.ts";

export type FileRecord = {
  path: string; // relative path from STORAGE_ROOT - the DB key, the disk suffix, and the URL suffix
  name: string; // basename, for Content-Disposition and the preview title
  bytes: number;
  protection: Protection;
  linkToken: string;
  ownerSub: string | null;
  uploaderSub: string | null;
  createdAt: string; // ISO 8601
  width: number | null; // D-74: image or video pixel width, captured at ingest
  height: number | null;
  durationSeconds: number | null; // video only
  textPreview: string | null; // .txt only
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

export function baseName(relPath: string): string {
  const segments = relPath.split("/");
  return segments[segments.length - 1] ?? relPath;
}

interface FileRow extends RowDataPacket {
  path: string;
  bytes: number;
  protection: Protection;
  link_token: string;
  owner_sub: string | null;
  uploader_sub: string | null;
  created_at: Date;
  width: number | null;
  height: number | null;
  duration_seconds: string | null; // mysql2 returns DECIMAL as a string
  text_preview: string | null;
}

function rowToRecord(row: FileRow, bytes: number): FileRecord {
  return {
    path: row.path,
    name: baseName(row.path),
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
  };
}

export async function deleteFileRow(relPath: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM file_acl WHERE path = ?", [relPath]);
  await pool.query("DELETE FROM files WHERE path = ?", [relPath]);
}

// Resolves the DB row for a relative path, then confirms the bytes are actually on disk. A row whose file
// has vanished is deleted and treated as gone (D-16: a dead link 404s). A path with no row is null - there
// is no drop-in, so an un-indexed file on disk is not served.
export async function resolveByPath(relPath: string): Promise<FileRecord | null> {
  const root = getStorageRoot();
  const safe = safeRelPath(relPath);
  if (safe === null) return null;

  const [rows] = await getPool().query<FileRow[]>(
    "SELECT path, bytes, protection, link_token, owner_sub, uploader_sub, created_at, width, height, duration_seconds, text_preview FROM files WHERE path = ?",
    [safe],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const absolutePath = resolveRelPath(root, safe);
  const entryStat = absolutePath === null ? null : await stat(absolutePath).catch(() => null);
  if (entryStat === null) {
    await deleteFileRow(safe);
    return null;
  }
  return rowToRecord(row, entryStat.size);
}

export async function resolveByToken(token: string): Promise<FileRecord | null> {
  const root = getStorageRoot();
  const [rows] = await getPool().query<FileRow[]>(
    "SELECT path, bytes, protection, link_token, owner_sub, uploader_sub, created_at, width, height, duration_seconds, text_preview FROM files WHERE link_token = ?",
    [token],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const absolutePath = resolveRelPath(root, row.path);
  const entryStat = absolutePath === null ? null : await stat(absolutePath).catch(() => null);
  if (entryStat === null) {
    await deleteFileRow(row.path);
    return null;
  }
  return rowToRecord(row, entryStat.size);
}

// Security invariant 6: sub is matched byte-for-byte, never parsed - a plain equality WHERE clause is
// exactly that. Used by the delivery controller to authorize `private` access for a non-owner/non-admin.
export async function hasAclGrant(relPath: string, sub: string): Promise<boolean> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT 1 FROM file_acl WHERE path = ? AND sub = ? LIMIT 1",
    [relPath, sub],
  );
  return rows.length > 0;
}

function isLinkTokenDuplicate(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ER_DUP_ENTRY" &&
    /link_token|uniq_link_token/.test((err as { message?: string }).message ?? "")
  );
}

// The upload-commit insert (preliminary-review P8: the file was already stripped on disk before this is
// called). Retries only on the astronomically-unlikely short-token collision; a duplicate PRIMARY KEY on
// `path` is a real conflict the caller should have avoided by suffixing, so it propagates.
export async function insertUploadedFile(params: {
  path: string;
  bytes: number;
  protection: Protection;
  ownerSub: string;
  uploaderSub: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  textPreview: string | null;
}): Promise<FileRecord> {
  const pool = getPool();
  for (let attempt = 0; attempt < 5; attempt++) {
    const linkToken = generateLinkToken();
    // Set explicitly (rather than relying on the column's DEFAULT CURRENT_TIMESTAMP) so the returned
    // FileRecord's createdAt is exactly what was stored, with no re-query round trip.
    const createdAt = new Date();
    try {
      await pool.query(
        `INSERT INTO files
          (path, bytes, protection, link_token, owner_sub, uploader_sub, width, height, duration_seconds, text_preview, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.path,
          params.bytes,
          params.protection,
          linkToken,
          params.ownerSub,
          params.uploaderSub,
          params.width,
          params.height,
          params.durationSeconds,
          params.textPreview,
          createdAt,
        ],
      );
      return {
        path: params.path,
        name: baseName(params.path),
        bytes: params.bytes,
        protection: params.protection,
        linkToken,
        ownerSub: params.ownerSub,
        uploaderSub: params.uploaderSub,
        createdAt: createdAt.toISOString(),
        width: params.width,
        height: params.height,
        durationSeconds: params.durationSeconds,
        textPreview: params.textPreview,
      };
    } catch (err) {
      if (isLinkTokenDuplicate(err)) continue; // regenerate the token and retry
      throw err;
    }
  }
  throw new Error("storage/files: could not generate a unique link token after 5 attempts");
}
