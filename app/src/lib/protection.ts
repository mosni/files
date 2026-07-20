// D-59: four protection levels replace the old "semi-private", because listing visibility and URL
// guessability are independent properties. This module only decides *shape* - whether a listing includes
// a file for a given viewer, and whether a readable path resolves at all for a protection level. It does
// not decide per-request session authorization for `private` delivery; that is a route-level concern in a
// later wave.

export type Protection = "public" | "unlisted" | "secret" | "private";

/** Is this file included in a listing for this viewer? */
export function isListedFor(
  protection: Protection,
  viewer: { sub: string | null; isAdmin: boolean },
  ownerSub: string | null,
): boolean {
  if (protection === "public") return true;
  if (viewer.isAdmin) return true;
  // unlisted/secret/private all share the same listing rule (D-59): hidden from public browsing, but
  // still visible in the owner's own listing. A file with no owner (D-57 - a bare mkdir) has no owner to
  // match against, so only the admin branch above can surface it.
  return viewer.sub !== null && ownerSub !== null && viewer.sub === ownerSub;
}

/** Does the readable mirrored path resolve for this protection level? `secret` must NOT. */
export function readablePathResolves(protection: Protection): boolean {
  // secret must 404 rather than 403 (D-59) - a 403 would confirm the file exists, which is the one
  // thing this level exists to hide. `private` still resolves in principle here; per-request session
  // authorization is a route-level concern, not this function's.
  return protection !== "secret";
}
