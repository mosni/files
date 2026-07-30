// Role checks. Session 007 (preliminary-review, Hannah's call) DROPPED files:admin: an admin is now just
// a user assigned both lower roles directly in auth, so there is no implication to encode here anymore
// (this strikes D-22 and D-49's implication design). `mosni_owner` remains the superuser bypass.

export type Claims = { sub: string; roles?: unknown; mosni_owner?: unknown };
export type FilesRole = "files:write" | "files:delete";

// auth's token also carries an optional `name` claim, not modeled on Claims above (which stays minimal to
// what can()/isSuperuser need). Shared wherever a human-readable display name is wanted in place of the
// raw sub - default collection naming (controllers/upload.ts) and audit actor labels (lib/audit.ts).
export type VerifiedClaims = Claims & { name?: unknown };

export function can(claims: Claims | null, role: FilesRole): boolean {
  if (claims === null) return false;
  if (claims.mosni_owner === true) return true;

  const roles = claims.roles;
  if (!Array.isArray(roles)) return false;
  return roles.includes(role);
}

// The superuser bypass, used where "can see/act on anyone's files" is needed (e.g. delivering a private
// file to an operator). With files:admin gone, this is the only cross-owner grant besides an explicit ACL.
export function isSuperuser(claims: Claims | null): boolean {
  return claims !== null && claims.mosni_owner === true;
}

// D-101: the E4 browse `scope=all` gate (and E8's admin panel, later) - an admin is simply a user holding
// BOTH lower roles. No separate mosni_owner branch: can() already returns true for a superuser on any
// role asked, so holding "both" falls out of that for free.
export function isFilesAdmin(claims: Claims | null): boolean {
  return can(claims, "files:write") && can(claims, "files:delete");
}
