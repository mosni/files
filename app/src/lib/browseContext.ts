// The shape GET /api/browse returns (§1.4 of the E4 waves hand-off), shared the same way
// lib/previewContext.ts's PreviewContext is: the API and web/src/components/FileBrowser.tsx code against
// this one definition rather than each declaring their own copy. Pure and I/O-free
// (technical-baseline.md §2) - resolution stays in storage/controllers/browse.ts.

import type { Protection, VisibilityReason } from "./protection.ts";

export type Scope = "mine" | "public" | "all";

export type BrowseCollection = {
  id: string;
  name: string;
  effectiveProtection: Protection;
  defaultProtection: Protection;
  reason: VisibilityReason;
  previewUrl: string;
};

export type BrowseFile = {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
  effectiveProtection: Protection;
  reason: VisibilityReason;
  previewUrl: string;
  directUrl: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export type BrowseResponse = {
  breadcrumb: { id: string; name: string }[];
  collections: BrowseCollection[];
  files: BrowseFile[];
  nextOffset: number | null;
};
