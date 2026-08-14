// E7 (§1.1 of the waves hand-off): the share dialog's shapes, shared the same way lib/browseContext.ts
// and lib/previewContext.ts are - one definition, imported by the API (controllers/share.ts) and by
// web/src/components/ShareDialog.tsx. Pure, I/O-free (technical-baseline.md §2).

import type { Protection } from "./protection.ts";

export type ShareObjectType = "file" | "collection";

// One row in the share dialog's "who can see this" list. `name` is auth's directory name when we could
// resolve one, and null otherwise - which is ALWAYS the case for an invited (link-bound) account, since
// auth's directory excludes them (D-191: no invites table, so an invite row is indistinguishable from any
// other grant and simply renders its sub). Rendering falls back to the sub, per D-168's precedent.
export type ShareGrant = {
  sub: string;
  name: string | null;
  picture: string | null;
  canUpload: boolean; // always false for a file grant - file_acl has no such column
};

// GET /api/accounts. Exactly auth's projection, passed through unchanged.
export type DirectoryAccount = { sub: string; name: string | null; picture: string };

// GET /api/shares?type=&id=
export type ShareState = {
  type: ShareObjectType;
  id: string;
  name: string;
  effectiveProtection: Protection;
  // E7-QA1 D-195: D-186's `shareable` field is REMOVED, not just unused - sharing now succeeds at every
  // protection level, so a boolean that is always `true` is a trap for the next reader. `effectiveProtection`
  // stays: the dialog uses it to render an informational note when a view grant would be inert (§B1.6).
  grants: ShareGrant[];
};

// POST /api/invites
export type InviteMinted = { url: string; expiresAt: string; sub: string };
