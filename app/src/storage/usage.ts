// E8 Wave B1: usage aggregation for the admin panel's Usage section. Every query filters
// state = 'committed' - a `pending` row (D-85) is an upload in flight whose bytes are not yet the app's,
// and counting it would make the figure jump mid-upload.

import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "./db.ts";
import type { Protection } from "../lib/protection.ts";

export type OwnerUsage = { ownerSub: string; bytes: number; fileCount: number };
// `protection`/`linkToken` are here so the caller can build the row's real share URL - a top-list row is a
// LINK (Hannah, 2026-08-19), and only the collection's own token can address it once its effective level
// stops resolving at a readable path (D-96/D-100).
export type CollectionUsage = {
  collectionId: string;
  name: string;
  ownerSub: string;
  bytes: number;
  fileCount: number;
  linkToken: string;
};

// SUM() over BIGINT UNSIGNED comes back from mysql2 as a string or a BigInt depending on magnitude -
// Number() maps both back to a JS number. Safe up to 2^53 (Number.MAX_SAFE_INTEGER), far beyond anything
// this box's ~2TB disk (technical-baseline.md) could ever hold in file bytes.
function toNumber(value: string | number | bigint): number {
  return Number(value);
}

export async function trackedBytesTotal(): Promise<{ bytes: number; fileCount: number }> {
  const [rows] = await getPool().query<(RowDataPacket & { bytes: string | number; fileCount: number })[]>(
    "SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS fileCount FROM files WHERE state = 'committed'",
  );
  const row = rows[0]!;
  return { bytes: toNumber(row.bytes), fileCount: row.fileCount };
}

export async function trackedBytesByOwner(): Promise<OwnerUsage[]> {
  const [rows] = await getPool().query<(RowDataPacket & { ownerSub: string; bytes: string | number; fileCount: number })[]>(
    `SELECT owner_sub AS ownerSub, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS fileCount
       FROM files WHERE state = 'committed' AND owner_sub IS NOT NULL
       GROUP BY owner_sub ORDER BY bytes DESC`,
  );
  return rows.map((row) => ({ ownerSub: row.ownerSub, bytes: toNumber(row.bytes), fileCount: row.fileCount }));
}

export async function trackedBytesTopCollections(limit: number): Promise<CollectionUsage[]> {
  const [rows] = await getPool().query<
    (RowDataPacket & {
      collectionId: string;
      name: string;
      ownerSub: string;
      bytes: string | number;
      fileCount: number;
      linkToken: string;
    })[]
  >(
    `SELECT f.collection_id AS collectionId, c.name AS name, c.owner_sub AS ownerSub, c.link_token AS linkToken,
            COALESCE(SUM(f.bytes), 0) AS bytes, COUNT(*) AS fileCount
       FROM files f JOIN collections c ON c.id = f.collection_id
       WHERE f.state = 'committed'
       GROUP BY f.collection_id, c.name, c.owner_sub, c.link_token ORDER BY bytes DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    collectionId: row.collectionId,
    name: row.name,
    ownerSub: row.ownerSub,
    bytes: toNumber(row.bytes),
    fileCount: row.fileCount,
    linkToken: row.linkToken,
  }));
}

// Live-testing addition (2026-08-19, Hannah): "top files should exist similar to top collections", both
// limited to the ten largest. One row per file - no GROUP BY, since a file is already the grain.
//
// LEFT JOIN, not JOIN: a root-level file has `collection_id = ''` (D-126) and no matching collections row,
// and the largest file on the box is exactly as likely to be sitting at the root as anywhere else. An
// INNER JOIN would silently drop it - the same shape as the bug that made topCollections omit root files,
// which is correct THERE (a root file is in no collection) and would be wrong here.
export type FileUsage = {
  fileId: string;
  name: string;
  collectionId: string;
  collectionName: string | null; // null for a root-level file
  protection: Protection;
  linkToken: string;
  ownerSub: string | null;
  bytes: number;
};

export async function trackedBytesTopFiles(limit: number): Promise<FileUsage[]> {
  const [rows] = await getPool().query<
    (RowDataPacket & {
      fileId: string;
      name: string;
      collectionId: string;
      collectionName: string | null;
      protection: Protection;
      linkToken: string;
      ownerSub: string | null;
      bytes: string | number;
    })[]
  >(
    `SELECT f.id AS fileId, f.name AS name, f.collection_id AS collectionId, c.name AS collectionName,
            f.protection AS protection, f.link_token AS linkToken, f.owner_sub AS ownerSub, f.bytes AS bytes
       FROM files f LEFT JOIN collections c ON c.id = f.collection_id
       WHERE f.state = 'committed'
       ORDER BY f.bytes DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    fileId: row.fileId,
    name: row.name,
    collectionId: row.collectionId,
    collectionName: row.collectionName,
    protection: row.protection,
    linkToken: row.linkToken,
    ownerSub: row.ownerSub,
    bytes: toNumber(row.bytes),
  }));
}
