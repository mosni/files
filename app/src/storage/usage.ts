// E8 Wave B1: usage aggregation for the admin panel's Usage section. Every query filters
// state = 'committed' - a `pending` row (D-85) is an upload in flight whose bytes are not yet the app's,
// and counting it would make the figure jump mid-upload.

import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "./db.ts";

export type OwnerUsage = { ownerSub: string; bytes: number; fileCount: number };
export type CollectionUsage = { collectionId: string; name: string; ownerSub: string; bytes: number; fileCount: number };

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
    (RowDataPacket & { collectionId: string; name: string; ownerSub: string; bytes: string | number; fileCount: number })[]
  >(
    `SELECT f.collection_id AS collectionId, c.name AS name, c.owner_sub AS ownerSub,
            COALESCE(SUM(f.bytes), 0) AS bytes, COUNT(*) AS fileCount
       FROM files f JOIN collections c ON c.id = f.collection_id
       WHERE f.state = 'committed'
       GROUP BY f.collection_id, c.name, c.owner_sub ORDER BY bytes DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    collectionId: row.collectionId,
    name: row.name,
    ownerSub: row.ownerSub,
    bytes: toNumber(row.bytes),
    fileCount: row.fileCount,
  }));
}
