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
export type AdminCollectionUsage = { collectionId: string; name: string; ownerSub: string; bytes: number; fileCount: number };

export type AdminUsageResponse = {
  volume: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
  tracked: { bytes: number; fileCount: number };
  untrackedBytes: number | null;
  byOwner: AdminOwnerUsage[];
  topCollections: AdminCollectionUsage[];
};
