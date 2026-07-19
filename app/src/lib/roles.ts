// D-49: this app owns its own role helper. The vendored auth verify snippet's `can()` implements only
// `mosni_owner === true || roles.includes(role)` - it does not implement D-22's implication
// (`files:admin` => `files:write` + `files:delete`), and auth issues a flat role array. Route code must
// import `can` from here, never from `auth/verify.ts`.

export type Claims = { sub: string; roles?: unknown; mosni_owner?: unknown };
export type FilesRole = "files:write" | "files:delete" | "files:admin";

const IMPLIES: Record<FilesRole, readonly FilesRole[]> = {
  "files:write": [],
  "files:delete": [],
  "files:admin": ["files:write", "files:delete"],
};

export function can(claims: Claims | null, role: FilesRole): boolean {
  if (claims === null) return false;
  if (claims.mosni_owner === true) return true;

  const roles = claims.roles;
  if (!Array.isArray(roles)) return false;

  return roles.some((held) => {
    if (held === role) return true;
    return typeof held === "string" && held in IMPLIES && IMPLIES[held as FilesRole].includes(role);
  });
}
