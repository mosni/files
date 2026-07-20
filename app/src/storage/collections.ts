// D-56/D-57/D-58: collections are the flat, globally-unique top-level directories under STORAGE_ROOT.
// This is the only module that reads/writes the `collections` table.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { RowDataPacket } from "mysql2/promise";
import { resolveCollectionPath, safeSegment, suffixForCollision } from "../lib/paths.ts";
import type { Protection } from "../lib/protection.ts";
import { getPool } from "./db.ts";

export type CollectionRecord = {
  id: string;
  name: string;
  ownerSub: string | null;
  protection: Protection;
  isDefault: boolean;
};

interface CollectionRow extends RowDataPacket {
  id: string;
  name: string;
  owner_sub: string | null;
  protection: Protection;
  is_default: number;
}

function toRecord(row: CollectionRow): CollectionRecord {
  return {
    id: row.id,
    name: row.name,
    ownerSub: row.owner_sub,
    protection: row.protection,
    isDefault: row.is_default === 1,
  };
}

export async function getCollectionByName(name: string): Promise<CollectionRecord | null> {
  const [rows] = await getPool().query<CollectionRow[]>(
    "SELECT id, name, owner_sub, protection, is_default FROM collections WHERE name = ?",
    [name],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

async function insertCollection(params: {
  name: string;
  ownerSub: string | null;
  protection: Protection;
  isDefault: boolean;
}): Promise<CollectionRecord> {
  const id = randomUUID();
  await getPool().query(
    "INSERT INTO collections (id, owner_sub, name, protection, is_default) VALUES (?, ?, ?, ?, ?)",
    [id, params.ownerSub, params.name, params.protection, params.isDefault],
  );
  return { id, ...params };
}

// D-57: a directory under STORAGE_ROOT with no `collections` row gets one on first touch - unowned,
// unlisted, visible only to files:admin until an admin assigns an owner. Returns null when neither a row
// nor a directory exists for this name (it genuinely is not a collection).
export async function getOrCreateCollectionForDiskEntry(
  storageRoot: string,
  name: string,
): Promise<CollectionRecord | null> {
  const existing = await getCollectionByName(name);
  if (existing !== null) return existing;

  const dirPath = resolveCollectionPath(storageRoot, name);
  if (dirPath === null) return null; // unsafe/reserved segment - never treated as a collection

  const entryStat = await stat(dirPath).catch(() => null);
  if (entryStat === null || !entryStat.isDirectory()) return null;

  return insertCollection({ name, ownerSub: null, protection: "unlisted", isDefault: false });
}

// Every account that uploads gets a default collection, created lazily on first upload (D-56/D-57
// context). `preferredName` is auth's optional `name` claim; falls back to `ownerSub` when auth issues
// none. D-58: collection names are globally unique, so a colliding name gets suffixed.
export async function getOrCreateDefaultCollection(
  ownerSub: string,
  preferredName?: string,
): Promise<CollectionRecord> {
  const [rows] = await getPool().query<CollectionRow[]>(
    "SELECT id, name, owner_sub, protection, is_default FROM collections WHERE owner_sub = ? AND is_default = TRUE",
    [ownerSub],
  );
  if (rows[0]) return toRecord(rows[0]);

  const desiredName = preferredName ?? ownerSub;
  const [nameRows] = await getPool().query<RowDataPacket[]>("SELECT name FROM collections");
  const taken = nameRows.map((row) => row.name as string);
  const candidate = suffixForCollision(desiredName, taken);

  // The candidate must still be a valid path segment (safeSegment rejects rather than sanitises) - a
  // sub/claims name containing something filesystem-unsafe is an environment we don't have a documented
  // policy for yet, so fail loudly rather than silently inventing one.
  if (safeSegment(candidate, "collection") === null) {
    throw new Error(`collections: cannot derive a safe default-collection name from "${desiredName}"`);
  }

  return insertCollection({ name: candidate, ownerSub, protection: "unlisted", isDefault: true });
}
