// E7-QA1 §A1.3/§A1.4: the shared "can this viewer see the object at all" oracle - owner, superuser, an
// explicit ACL row on the object itself, or a grant on any ancestor collection (D-99's identity list,
// matched byte-for-byte - security invariant 6). Extracted so controllers/preview.ts (gates whether a
// private file's context/document may be sent at all) and controllers/manage.ts (A1.4: distinguishes
// "cannot see this at all" -> 404 from "can see it, may not manage it" -> 403) can never independently
// drift on what "can see" means - the exact class of duplication this project's review lenses call out.

import type { Claims } from "./roles.ts";
import { isSuperuser } from "./roles.ts";
import { hasAclGrant } from "../storage/files.ts";
import { hasAclGrantOnChain } from "../storage/collections.ts";

export async function canSeeFile(
  claims: Claims,
  record: { id: string; ownerSub: string | null; collectionId: string },
): Promise<boolean> {
  const isOwner = record.ownerSub !== null && claims.sub === record.ownerSub;
  return (
    isOwner ||
    isSuperuser(claims) ||
    (await hasAclGrant(record.id, claims.sub)) ||
    (await hasAclGrantOnChain(record.collectionId, claims.sub))
  );
}

// hasAclGrantOnChain(collectionId, sub) already checks the collection's OWN row before climbing (see its
// own header comment in storage/collections.ts), so one call covers "granted on this collection or any
// ancestor" - no separate hasCollectionAclGrant call is needed here.
export async function canSeeCollection(claims: Claims, record: { id: string; ownerSub: string }): Promise<boolean> {
  const isOwner = claims.sub === record.ownerSub;
  return isOwner || isSuperuser(claims) || (await hasAclGrantOnChain(record.id, claims.sub));
}
