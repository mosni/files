// D-59: four protection levels replace the old "semi-private", because listing visibility and URL
// guessability are independent properties. This module only decides *shape* - whether a listing includes
// a file for a given viewer, and whether a readable path resolves at all for a protection level. It does
// not decide per-request session authorization for `private` delivery; that is a route-level concern in a
// later wave.

export type Protection = "public" | "unlisted" | "secret" | "private";

// D-96: restrictiveness order, most permissive first. Used to fold an ancestor chain (plus a row's own
// level) down to the single EFFECTIVE level a read path must honour - never the stored column alone.
export const PROTECTION_ORDER: Record<Protection, number> = {
  public: 0,
  unlisted: 1,
  secret: 2,
  private: 3,
};

/**
 * The most restrictive level among a chain of levels (an ancestor collection chain, plus a file's own
 * stored level). Pure and I/O-free (D-96, technical-baseline.md §2) - the caller (storage) has already
 * fetched every level in the chain; this just folds them.
 */
export function mostRestrictive(levels: readonly Protection[]): Protection {
  if (levels.length === 0) {
    throw new Error("lib/protection: mostRestrictive() requires at least one level");
  }
  return levels.reduce((worst, level) => (PROTECTION_ORDER[level] > PROTECTION_ORDER[worst] ? level : worst));
}

export type VisibilityReason = "own" | "admin" | "granted" | "public";

/**
 * Is this row included in a listing for this viewer, and if so, why (D-103's "why can I see this")?
 *
 * `protection` MUST be the row's EFFECTIVE level (D-96) - resolved in storage from the ancestor chain,
 * never the stored column read directly. `granted` is an ACL grant on the row or any ancestor collection
 * (D-99); like the protection chain, that is DB I/O, so it is resolved by the caller and handed in as a
 * value - this function stays pure. Precedence (D-103): own, then granted, then admin, then public - an
 * owner who also happens to hold a grant reads as "own", not "granted".
 */
export function isListedFor(
  protection: Protection,
  viewer: { sub: string | null; isAdmin: boolean },
  ownerSub: string | null,
  granted: boolean,
): VisibilityReason | null {
  if (viewer.sub !== null && ownerSub !== null && viewer.sub === ownerSub) return "own";
  if (granted) return "granted";
  if (viewer.isAdmin) return "admin";
  if (protection === "public") return "public";
  return null;
}

/** Does the readable mirrored path resolve for this protection level? `secret` must NOT. */
export function readablePathResolves(protection: Protection): boolean {
  // secret must 404 rather than 403 (D-59) - a 403 would confirm the file exists, which is the one
  // thing this level exists to hide. `private` still resolves in principle here; per-request session
  // authorization is a route-level concern, not this function's.
  return protection !== "secret";
}
