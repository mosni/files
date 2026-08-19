// The wire shape E8's admin API returns (GET /api/admin/grants, GET /api/admin/usage) - shared the same
// way lib/browseContext.ts's BrowseFile/BrowseCollection are, so controllers/admin.ts and
// web/src/lib/admin.ts code against one definition instead of each declaring their own copy. Pure and
// I/O-free (technical-baseline.md §2).

export type AdminGrantRow = {
  targetType: "file" | "collection";
  targetId: string;
  targetName: string;
  ownerSub: string | null;
  sub: string;
  canUpload: boolean;
  grantedAt: string; // ISO-8601
  expiresAt: string | null; // ISO-8601, or null for permanent-until-revoked
  status: "active" | "expired";
};

export type AdminOwnerUsage = { ownerSub: string; bytes: number; fileCount: number };

// `url` is built server-side (controllers/admin.ts) from the object's EFFECTIVE protection, exactly like
// every other link this app hands out (D-96/D-100) - the client never constructs one, because it never
// sees a link_token. Null when the row vanished between the aggregate and the URL resolution, in which
// case the panel renders a plain label rather than a dead link.
export type AdminCollectionUsage = {
  collectionId: string;
  name: string;
  ownerSub: string;
  bytes: number;
  fileCount: number;
  url: string | null;
};

export type AdminFileUsage = {
  fileId: string;
  name: string;
  collectionName: string | null; // null for a root-level file (D-126)
  ownerSub: string | null;
  bytes: number;
  url: string | null;
};

export type AdminUsageResponse = {
  volume: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
  tracked: { bytes: number; fileCount: number };
  untrackedBytes: number | null;
  byOwner: AdminOwnerUsage[];
  topCollections: AdminCollectionUsage[];
  topFiles: AdminFileUsage[];
};
