// Role checks. Session 007 (preliminary-review, Hannah's call) DROPPED files:admin: an admin is now just
// a user assigned both lower roles directly in auth, so there is no implication to encode here anymore
// (this strikes D-22 and D-49's implication design). `mosni_owner` remains the superuser bypass.

export type Claims = { sub: string; roles?: unknown; mosni_owner?: unknown };
export type FilesRole = "files:write" | "files:delete";

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
