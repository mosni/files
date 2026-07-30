// The shape GET /api/browse returns (§1.4 of the E4 waves hand-off), shared the same way
// lib/previewContext.ts's PreviewContext is: the API and web/src/components/FileBrowser.tsx code against
// this one definition rather than each declaring their own copy. Pure and I/O-free
// (technical-baseline.md §2) - resolution stays in storage/controllers/browse.ts.

import type { Protection, VisibilityReason } from "./protection.ts";

// D-116/E4.1 Wave E findings: collapsed from three scopes to two. "public" and "all" are DELETED, not
// deprecated - "visible" replaces both with one server-decided contract ("everything this viewer can
// see"), so the client never branches on role. See controllers/browse.ts's header comment.
export type Scope = "mine" | "visible";

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

// E4.1 Wave C: `previewUrl` lets a breadcrumb crumb be a real link (C4) without the client ever
// constructing a URL itself (D-100) - same shape and same reasoning as BrowseCollection.previewUrl.
export type BrowseResponse = {
  breadcrumb: { id: string; name: string; previewUrl: string }[];
  collections: BrowseCollection[];
  files: BrowseFile[];
  nextOffset: number | null;
};

// D-107/§1.2 of the E4.1 waves hand-off: what the SPA shell's embedded context carries when a `/f/*` or
// `/t/<token>` document resolves to a collection rather than a file - `kind: "collection"` deliberately
// can never collide with PreviewContext's own `kind` field (always "image" | "video" | "pdf" | "text" |
// "other"), so the client can tell the two shapes apart from the same embedded <script id="preview-context">.
export type CollectionLocation = {
  kind: "collection";
  collectionId: string;
};
