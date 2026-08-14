// E7-QA1 §A1.5 (F12): the ONE breadcrumb builder, extracted from controllers/browse.ts so
// controllers/preview.ts's PreviewContext.ancestors and /api/browse's own breadcrumb can never drift -
// two copies would be exactly the failure mode the D-100 redaction below must not have. Pure logic given
// an already-resolved chain (technical-baseline.md §2 - I/O stays in storage/, this only shapes it).

import type { Config } from "../config.ts";
import type { Claims } from "./roles.ts";
import { isSuperuser } from "./roles.ts";
import { mostRestrictive, type Protection } from "./protection.ts";
import { buildCollectionPreviewUrl } from "./fileUrls.ts";
import { collectionBreadcrumb, hasAclGrantOnChain } from "../storage/collections.ts";

export type BreadcrumbCrumb = { id: string; name: string; previewUrl: string };

// `targetChain` is root-first, already resolved by the caller (protectionChain(collectionId)) - reused
// rather than re-walked here, matching controllers/browse.ts's own performance note (resolve the chain
// once per request, not once per crumb). Empty collectionId (root) returns [].
export async function buildBreadcrumb(
  config: Config,
  collectionId: string,
  targetChain: readonly Protection[],
  claims: Claims | null,
): Promise<BreadcrumbCrumb[]> {
  if (collectionId === "") return [];
  const rawBreadcrumb = await collectionBreadcrumb(collectionId);
  return Promise.all(
    rawBreadcrumb.map(async (crumb, i) => {
      const crumbEffective = mostRestrictive(targetChain.slice(0, i + 1));
      const segmentsUpToHere = rawBreadcrumb.slice(0, i + 1).map((c) => c.name);
      let previewUrl = buildCollectionPreviewUrl(config, crumbEffective, segmentsUpToHere, crumb.linkToken);
      // D-100 (narrow but real): being independently authorized on the deeper TARGET does not imply
      // authorization on every ancestor above it (an ACL grant can be scoped to one nested collection with
      // none on its parent) - so a SECRET ancestor's real token must not ride along in the breadcrumb for a
      // viewer who isn't independently authorized on THAT ancestor specifically. The name stays (it is
      // orientation, not a credential - app/test/integration/browse.test.ts's own D-100 test is explicit
      // about this); every other level already gets the readable /f/ form (dead-but-safe if the viewer
      // can't open it), so only "secret" needs the extra check.
      if (crumbEffective === "secret") {
        const ancestorAuthorized =
          claims !== null &&
          (claims.sub === crumb.ownerSub || isSuperuser(claims) || (await hasAclGrantOnChain(crumb.id, claims.sub)));
        if (!ancestorAuthorized) {
          // Any non-secret protection forces buildCollectionPreviewUrl's readable-path branch without
          // exposing the real token - the link is simply dead (404s for everyone) rather than a leak.
          previewUrl = buildCollectionPreviewUrl(config, "private", segmentsUpToHere, crumb.linkToken);
        }
      }
      return { id: crumb.id, name: crumb.name, previewUrl };
    }),
  );
}
