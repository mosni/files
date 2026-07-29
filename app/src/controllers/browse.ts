// GET /api/browse (§1.4 of the E4 waves hand-off). Three scopes share one endpoint:
//   scope=mine   - the caller's own collections and files. Bearer required.
//   scope=public - the public collection tree. No Bearer required (D-94) - the app's only anonymous
//                  listing endpoint, and the only place a missing effective-protection check becomes a
//                  public leak.
//   scope=all    - every collection and file regardless of owner. Gated on isFilesAdmin (D-101).
//
// D-96 landmine, again: every row's EFFECTIVE protection is computed here from the target collection's
// own protection chain (already fetched once per request, not once per row - the hand-off's own
// performance note) folded with each row's own stored level, never the stored column alone.
//
// E4.1 Wave C: scope=public's target-collection gate was originally "reachable only if the WHOLE chain is
// itself public" (D-94's anonymous tree). That left a real gap once E4.1 made a collection's document
// resolve for a non-owner authorized viewer (Wave A's D-107/D-99): the document would 200, but its
// LISTING still 404d for anyone who wasn't the owner or scope=mine/scope=all. isAuthorizedForTarget below
// is the SAME identity list D-99 already uses everywhere else (owner, superuser, an ACL grant anywhere on
// the chain) plus D-98's token bypass, applied to the one remaining gate that didn't have it.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { isFilesAdmin, isSuperuser, type Claims } from "../lib/roles.ts";
import { buildCollectionPreviewUrl, buildFileUrls } from "../lib/fileUrls.ts";
import { isListedFor, mostRestrictive, type Protection, type VisibilityReason } from "../lib/protection.ts";
import type { BrowseCollection, BrowseFile, BrowseResponse, Scope } from "../lib/browseContext.ts";
import {
  collectionBreadcrumb,
  hasAclGrantOnChain,
  hasCollectionAclGrant,
  listAllChildCollections,
  listOwnedChildCollections,
  listPublicChildCollections,
  protectionChain,
  resolveCollectionById,
  type CollectionRecord,
} from "../storage/collections.ts";
import {
  hasAclGrant,
  listAllFilesIn,
  listOwnedFilesIn,
  listPublicFilesIn,
  type FileRecord,
} from "../storage/files.ts";

const PAGE_SIZE = 100;

function isScope(value: unknown): value is Scope {
  return value === "mine" || value === "public" || value === "all";
}

type Viewer = { sub: string | null; isAdmin: boolean };

// Everything on one page shares the SAME ancestor chain: every listed file lives in the target collection
// itself, and every listed child collection has the target as its parent. So the D-99 grant is
// `chainGranted` (resolved once per request, below) OR one single-level check on the row itself - never a
// fresh ancestor walk per row. That is the hand-off's own performance note ("resolve the chain once per
// collection, not once per file") applied to the ACL walk as well as the protection chain; it matters here
// because the box is an Atom N2800 (D-78) and a page is 100 rows.
type PageGrants = { chainGranted: boolean };

// E4.1 Wave C: is `claims`/`suppliedToken` allowed into a NON-public target collection under scope=public -
// the D-99 identity list (owner, superuser, an ACL grant anywhere on the chain) plus D-98's token bypass.
// The caller checks mostRestrictive(targetChain) !== "public" first (cheap, no I/O) before ever calling
// this, so this only runs for a target that actually needs the extra check.
async function isAuthorizedForTarget(
  target: CollectionRecord,
  claims: Claims | null,
  suppliedToken: string | null,
): Promise<boolean> {
  if (suppliedToken !== null && suppliedToken === target.linkToken) return true;
  if (claims === null) return false;
  if (claims.sub === target.ownerSub) return true;
  if (isSuperuser(claims)) return true;
  return hasAclGrantOnChain(target.id, claims.sub);
}

async function resolvePageGrants(collectionId: string, viewer: Viewer): Promise<PageGrants> {
  if (viewer.sub === null || collectionId === "") return { chainGranted: false };
  return { chainGranted: await hasAclGrantOnChain(collectionId, viewer.sub) };
}

// isListedFor (lib/protection.ts) stays the single authority on D-103's precedence - this only decides
// whether the `granted` argument needs to be looked up at all. It never does when the viewer owns the row:
// isListedFor returns "own" before it reads `granted`, so passing false there is provably answer-
// preserving, and it saves a query per row on the commonest signed-in path (scope=mine, where every row is
// the viewer's own).
async function reasonFor(
  effectiveProtection: Protection,
  ownerSub: string | null,
  viewer: Viewer,
  resolveGranted: () => Promise<boolean>,
): Promise<VisibilityReason> {
  const isOwn = viewer.sub !== null && ownerSub !== null && viewer.sub === ownerSub;
  const granted = isOwn ? false : await resolveGranted();
  // The ?? is unreachable for every scope this endpoint serves (scope=mine rows are all "own",
  // scope=public rows are all public-effective, scope=all only answers an isAdmin viewer) - it exists so a
  // future scope cannot make this return undefined.
  return isListedFor(effectiveProtection, viewer, ownerSub, granted) ?? "public";
}

// Effective protection given the already-fetched chain of the TARGET collection being browsed (root-
// first, including the target's own level) plus a row's own level - mostRestrictive() needs at least one
// element, and at the true root there is no target chain at all.
function effectiveOf(targetChain: readonly Protection[], own: Protection): Protection {
  return mostRestrictive(targetChain.length === 0 ? [own] : [...targetChain, own]);
}

async function shapeCollection(
  config: Config,
  record: CollectionRecord,
  targetChain: readonly Protection[],
  pathSegments: readonly string[],
  viewer: Viewer,
  grants: PageGrants,
): Promise<BrowseCollection> {
  const effectiveProtection = effectiveOf(targetChain, record.protection);
  // A grant on this collection itself, or anywhere above it - and everything above it is the page's shared
  // chain, already resolved. Equivalent to hasAclGrantOnChain(record.id) by construction, one query deep.
  const reason = await reasonFor(effectiveProtection, record.ownerSub, viewer, async () =>
    grants.chainGranted || (viewer.sub !== null && (await hasCollectionAclGrant(record.id, viewer.sub))),
  );
  const previewUrl = buildCollectionPreviewUrl(
    config,
    effectiveProtection,
    [...pathSegments, record.name],
    record.linkToken,
  );
  return {
    id: record.id,
    name: record.name,
    effectiveProtection,
    defaultProtection: record.defaultProtection,
    reason,
    previewUrl,
  };
}

async function shapeFile(
  config: Config,
  record: FileRecord,
  targetChain: readonly Protection[],
  pathSegments: readonly string[],
  viewer: Viewer,
  grants: PageGrants,
): Promise<BrowseFile> {
  const effectiveProtection = effectiveOf(targetChain, record.protection);
  // A file's own file_acl row, or a grant anywhere on its collection chain - and its collection IS the
  // page's target, so that half is `grants.chainGranted`. Equivalent to the per-row walk, one query deep.
  const reason = await reasonFor(effectiveProtection, record.ownerSub, viewer, async () =>
    grants.chainGranted || (viewer.sub !== null && (await hasAclGrant(record.id, viewer.sub))),
  );
  const urls = buildFileUrls(config, effectiveProtection, [...pathSegments, record.name], record.linkToken);
  return {
    id: record.id,
    name: record.name,
    bytes: record.bytes,
    createdAt: record.createdAt,
    effectiveProtection,
    reason,
    previewUrl: urls.previewUrl,
    directUrl: urls.directUrl,
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
  };
}

// E4.1 Wave C: `elevated` is true only for scope=public, only for a specific target collectionId, and only
// when the viewer is independently authorized on that target (isAuthorizedForTarget's owner/superuser/
// chain-grant identities, computed once by the caller - never the token bypass, which grants document
// access but not elevated listing). Reaching a non-public target (the gate above) does not by itself widen
// what its LISTING shows: without this, an owner browsing their own unlisted collection via scope=public
// would still only see its `protection = 'public'` rows, because listPublicFilesIn/listPublicChildCollections
// filter at the SQL level regardless of viewer identity. Collections are single-owner (D-99's grants are
// collection-scoped, not per-file - E7 owns any finer-grained sharing), so "elevated" means "show every row
// in this one collection," the same breadth listOwnedFilesIn/listAllFilesIn already give scope=mine/scope=all.
async function listChildCollections(
  scope: Scope,
  parentId: string,
  viewer: Viewer,
  elevated: boolean,
): Promise<CollectionRecord[]> {
  if (scope === "public") return elevated ? listAllChildCollections(parentId) : listPublicChildCollections(parentId);
  if (scope === "all") return listAllChildCollections(parentId);
  return listOwnedChildCollections(parentId, viewer.sub!);
}

async function listFilesFor(
  scope: Scope,
  collectionId: string,
  viewer: Viewer,
  elevated: boolean,
): Promise<FileRecord[]> {
  if (collectionId === "") return []; // the pseudo-root never holds files directly (D-80)
  if (scope === "public") return elevated ? listAllFilesIn(collectionId) : listPublicFilesIn(collectionId);
  if (scope === "all") return listAllFilesIn(collectionId);
  return listOwnedFilesIn(collectionId, viewer.sub!);
}

export async function browseHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const query = request.query as Record<string, unknown>;

  if (!isScope(query.scope)) {
    reply.code(400).send({ error: "invalid_scope" });
    return;
  }
  const scope = query.scope;

  const collectionId = typeof query.collectionId === "string" ? query.collectionId : "";

  const rawOffset = query.offset;
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    reply.code(400).send({ error: "invalid_offset" });
    return;
  }

  const claims = await claimsFromBearer(request, config.appOrigin);

  if (scope === "mine" && claims === null) {
    reply.code(401).send();
    return;
  }
  // D-101: scope=all is gated on holding both lower roles (mosni_owner satisfies it via can()'s existing
  // bypass) - a non-admin caller gets the same 404 any unauthorized target does, never a 403 that would
  // confirm the endpoint exists for them to escalate toward.
  if (scope === "all" && (claims === null || !isFilesAdmin(claims))) {
    reply.code(404).send();
    return;
  }

  const viewer: Viewer = { sub: claims?.sub ?? null, isAdmin: claims !== null && isFilesAdmin(claims) };

  let targetChain: Protection[] = [];
  let targetOwnerSub: string | null = null;
  let breadcrumb: { id: string; name: string; previewUrl: string }[] = [];
  let pathSegments: string[] = [];

  if (collectionId !== "") {
    const target = await resolveCollectionById(collectionId);
    if (target === null) {
      reply.code(404).send();
      return;
    }
    targetOwnerSub = target.ownerSub;
    if (scope === "mine" && target.ownerSub !== claims!.sub) {
      reply.code(404).send();
      return;
    }
    targetChain = await protectionChain(collectionId); // root-first, includes the target's own level
    if (scope === "public" && mostRestrictive(targetChain) !== "public") {
      // D-94's public tree only descends anonymously through collections that are themselves public all
      // the way down - UNLESS the caller is independently authorized into this one target (E4.1 Wave C):
      // its own token (D-98), its owner, a superuser, or an ACL grant anywhere on its chain (D-99). This
      // is what lets a collection resolved by Wave A's document route actually list its contents too.
      const rawToken = query.token;
      const suppliedToken = typeof rawToken === "string" ? rawToken : null;
      if (!(await isAuthorizedForTarget(target, claims, suppliedToken))) {
        reply.code(404).send();
        return;
      }
    }
    const rawBreadcrumb = await collectionBreadcrumb(collectionId);
    // E4.1 Wave C: each crumb's OWN previewUrl, built the same way a row's is - its effective protection
    // is the chain up to and including itself (root-first, matching targetChain's order), never the
    // stored column (D-96).
    breadcrumb = await Promise.all(
      rawBreadcrumb.map(async (crumb, i) => {
        const crumbEffective = mostRestrictive(targetChain.slice(0, i + 1));
        const segmentsUpToHere = rawBreadcrumb.slice(0, i + 1).map((c) => c.name);
        let previewUrl = buildCollectionPreviewUrl(config, crumbEffective, segmentsUpToHere, crumb.linkToken);
        // D-100 (narrow but real): being independently authorized on the deeper TARGET does not imply
        // authorization on every ancestor above it (an ACL grant can be scoped to one nested collection
        // with none on its parent) - so a SECRET ancestor's real token must not ride along in the
        // breadcrumb for a viewer who isn't independently authorized on THAT ancestor specifically. Every
        // other level already gets the readable /f/ form (dead-but-safe if the viewer can't open it), so
        // only "secret" needs the extra check.
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
    pathSegments = rawBreadcrumb.map((crumb) => crumb.name);
  }

  const grants = await resolvePageGrants(collectionId, viewer);
  // See listChildCollections'/listFilesFor's header comment - this is the SAME identity list
  // isAuthorizedForTarget already used for the reachability gate above, minus the token bypass (a bare
  // token authorizes this one document/listing, not elevated visibility into every row it contains).
  const elevatedPublicAccess =
    scope === "public" &&
    targetOwnerSub !== null &&
    (viewer.sub === targetOwnerSub || (claims !== null && isSuperuser(claims)) || grants.chainGranted);

  const [childCollections, files] = await Promise.all([
    listChildCollections(scope, collectionId, viewer, elevatedPublicAccess),
    listFilesFor(scope, collectionId, viewer, elevatedPublicAccess),
  ]);

  // D-102: collections first, then files, each newest-first (already the query order) - paginate the
  // COMBINED [...collections, ...files] sequence at PAGE_SIZE.
  const combinedLength = childCollections.length + files.length;
  const pageCollections = childCollections.slice(offset, offset + PAGE_SIZE);
  const remainingCapacity = PAGE_SIZE - pageCollections.length;
  const fileStart = Math.max(0, offset - childCollections.length);
  const pageFiles = remainingCapacity > 0 ? files.slice(fileStart, fileStart + remainingCapacity) : [];
  const consumedThroughThisPage = offset + pageCollections.length + pageFiles.length;
  const nextOffset = consumedThroughThisPage < combinedLength ? offset + PAGE_SIZE : null;

  const shapedCollections = await Promise.all(
    pageCollections.map((record) => shapeCollection(config, record, targetChain, pathSegments, viewer, grants)),
  );
  const shapedFiles = await Promise.all(
    pageFiles.map((record) => shapeFile(config, record, targetChain, pathSegments, viewer, grants)),
  );

  const response: BrowseResponse = {
    breadcrumb,
    collections: shapedCollections,
    files: shapedFiles,
    nextOffset,
  };
  reply.send(response);
}
