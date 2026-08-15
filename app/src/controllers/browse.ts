// GET /api/browse (D-116/§1.1 of the E4.1 Wave E findings hand-off). Two scopes share one endpoint:
//   scope=mine    - the caller's own collections and files. Bearer required.
//   scope=visible - everything THIS VIEWER can see. No Bearer required (D-94) - the app's only anonymous
//                   listing endpoint, and the only place a missing effective-protection check becomes a
//                   public leak. Anonymous -> public rows only. Signed in -> public ∪ own ∪ ACL-granted.
//                   An admin (isFilesAdmin) -> everything, because an admin can see every file. This is
//                   ONE contract decided from the caller's identity - the client sends the same scope for
//                   every viewer and never branches on role.
//
// `scope=public` and `scope=all` are DELETED, not deprecated (D-116) - both now hit the same 400
// invalid_scope any other unknown value gets. D-101's admin gate is not dropped: it survives as the
// `visible` scope's admin branch (an admin is gated INTO full breadth, never gated OUT of a scope name).
//
// D-96 landmine, again: every row's EFFECTIVE protection is computed here from the target collection's
// own protection chain (already fetched once per request, not once per row - the hand-off's own
// performance note) folded with each row's own stored level, never the stored column alone.
//
// E4.1 Wave C (original E4.1): scope=public's target-collection gate was originally "reachable only if
// the WHOLE chain is itself public" (D-94's anonymous tree). That left a real gap once E4.1 made a
// collection's document resolve for a non-owner authorized viewer (D-107/D-99): the document would 200,
// but its LISTING still 404d for anyone who wasn't the owner or scope=mine/scope=all. isAuthorizedForTarget
// below is the SAME identity list D-99 already uses everywhere else (owner, superuser, isFilesAdmin, an
// ACL grant anywhere on the chain) plus D-98's token bypass, applied to the one remaining gate that didn't
// have it.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { can, isFilesAdmin, isSuperuser, type Claims } from "../lib/roles.ts";
import {
  buildCollectionPreviewUrl,
  buildFileUrls,
  buildSignedDeliveryUrls,
  buildThumbUrl,
} from "../lib/fileUrls.ts";
import { fileKindFor } from "../lib/fileKind.ts";
import { isListedFor, mostRestrictive, type Protection, type VisibilityReason } from "../lib/protection.ts";
import type { BrowseCollection, BrowseFile, BrowseResponse, Scope } from "../lib/browseContext.ts";
import { buildBreadcrumb } from "../lib/breadcrumb.ts";
import {
  hasAclGrantOnChain,
  hasCollectionAclGrant,
  listAllChildCollections,
  listLinkAuthorizedChildCollections,
  listOwnedChildCollections,
  listVisibleChildCollections,
  protectionChain,
  resolveCollectionById,
  canUploadTo,
  type CollectionRecord,
} from "../storage/collections.ts";
import {
  hasAclGrant,
  listAllFilesIn,
  listLinkAuthorizedFilesIn,
  listOwnedFilesIn,
  listVisibleFilesIn,
  type FileRecord,
} from "../storage/files.ts";

const PAGE_SIZE = 100;

function isScope(value: unknown): value is Scope {
  return value === "mine" || value === "visible";
}

type Viewer = { sub: string | null; isAdmin: boolean };

// Everything on one page shares the SAME ancestor chain: every listed file lives in the target collection
// itself, and every listed child collection has the target as its parent. So the D-99 grant is
// `chainGranted` (resolved once per request, below) OR one single-level check on the row itself - never a
// fresh ancestor walk per row. That is the hand-off's own performance note ("resolve the chain once per
// collection, not once per file") applied to the ACL walk as well as the protection chain; it matters here
// because the box is an Atom N2800 (D-78) and a page is 100 rows.
//
// `linkAuthorizedOnly` (D-125, E4.1 live-testing findings, Wave B - renamed from A5's tokenAuthorizedOnly)
// is true only when the WHOLE page's reachability was granted purely by the target collection's link -
// its token (secret) or its readable path (unlisted/public, D-124) - not by identity (owner/superuser/
// isAdmin/chain-grant). Threaded into reasonFor() below so a link-authorized listing's rows are labelled
// "granted", never mislabelled "public", and into listChildCollections/listFilesFor to pick the widened
// D-125 breadth.
//
// `hostedInOwnCollection` (D-189, E7) is a PAGE-LEVEL fact, not a per-row one: true only when the viewer
// owns the collection being browsed (`viewer.sub === targetOwnerSub`), computed once in browseHandler. It
// is never a new query - every row on this page already lives inside the same target the viewer owns, so
// every row that is not the viewer's OWN gets the same "hosted" answer.
type PageGrants = { chainGranted: boolean; linkAuthorizedOnly: boolean; hostedInOwnCollection: boolean };

// D-99's identity list for reaching a NON-public target collection: owner, superuser, isFilesAdmin (D-101
// survives here as `visible`'s admin branch - an admin browsing into any collection must not 404, which is
// what scope=all used to provide), or an ACL grant anywhere on the chain. Deliberately excludes the D-98
// token bypass - that is checked separately by the caller, which is what lets it distinguish "reached by
// identity" from "reached only by token" for A5's tokenAuthorizedOnly.
async function isIdentityAuthorizedForTarget(target: CollectionRecord, claims: Claims | null): Promise<boolean> {
  if (claims === null) return false;
  if (claims.sub === target.ownerSub) return true;
  if (isSuperuser(claims)) return true;
  if (isFilesAdmin(claims)) return true;
  return hasAclGrantOnChain(target.id, claims.sub);
}

async function resolvePageGrants(collectionId: string, viewer: Viewer): Promise<{ chainGranted: boolean }> {
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
  linkAuthorizedOnly: boolean,
  hostedInOwnCollection: boolean,
): Promise<VisibilityReason> {
  const isOwn = viewer.sub !== null && ownerSub !== null && viewer.sub === ownerSub;
  const granted = isOwn ? false : await resolveGranted();
  const reason = isListedFor(effectiveProtection, viewer, ownerSub, granted, hostedInOwnCollection);
  if (reason !== null) return reason;
  // D-125 (renamed from A5's tokenAuthorizedOnly): isListedFor legitimately returns null for a row this
  // endpoint chose to list ONLY when the whole page's reachability came from the target collection's own
  // link - token (secret) or readable path (unlisted, D-124) - for an anonymous, non-granted, non-admin
  // viewer. D-98/D-124 grant the link holder the LISTING, and every row on it is exactly as visible as the
  // collection itself, so reusing the existing "granted" case (D-103's four cases are locked - no fifth)
  // is accurate: "Shared with you" is exactly what a link-shared collection is. The OLD `?? "public"`
  // fallback silently mislabelled this case.
  // Any OTHER null means this endpoint listed a row isListedFor cannot explain - a bug, so this throws
  // rather than defaulting, the same fail-loud choice hasAclGrantOnChain already makes.
  if (linkAuthorizedOnly) return "granted";
  throw new Error(
    `controllers/browse: isListedFor returned null for a row this endpoint chose to list ` +
      `(effectiveProtection=${effectiveProtection}, ownerSub=${ownerSub ?? "null"}) - every listed row must be explainable`,
  );
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
  const reason = await reasonFor(
    effectiveProtection,
    record.ownerSub,
    viewer,
    async () => grants.chainGranted || (viewer.sub !== null && (await hasCollectionAclGrant(record.id, viewer.sub))),
    grants.linkAuthorizedOnly,
    grants.hostedInOwnCollection,
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
  const reason = await reasonFor(
    effectiveProtection,
    record.ownerSub,
    viewer,
    async () => grants.chainGranted || (viewer.sub !== null && (await hasAclGrant(record.id, viewer.sub))),
    grants.linkAuthorizedOnly,
    grants.hostedInOwnCollection,
  );
  // E7-QA1 round 3 (Hannah): "the thumbnail does not load for private files ... changing it to unlisted
  // fixed it". A `private` file's path/token URLs resolve to routes that run authorizePrivate(), and
  // dl.mosni.dev has no session to authorize with (D-33: no cookie on that origin, and neither an `<img>`
  // nor the archive's cross-origin fetch() can carry a Bearer) - so both answered 401/403 and the row's
  // thumbnail rendered as the browser's broken-image icon. The preview page already solved this with a
  // D-84 signed URL; the listing simply never got one. Same pair, same helper, so they cannot drift.
  //
  // Safe to mint here: a `private` row only reaches this listing via listOwnedFilesIn, listVisibleFilesIn's
  // identity branch, or the admin branch - a link-authorized listing excludes `private` outright (D-99) -
  // so every viewer handed one of these is already authorized to read the bytes.
  const signed =
    effectiveProtection === "private"
      ? buildSignedDeliveryUrls(config, record.id, record.thumbName !== null)
      : null;
  const urls =
    signed !== null
      ? {
          ...buildFileUrls(config, effectiveProtection, [...pathSegments, record.name], record.linkToken),
          directUrl: signed.directUrl,
        }
      : buildFileUrls(config, effectiveProtection, [...pathSegments, record.name], record.linkToken);
  const thumbUrl =
    signed !== null
      ? signed.thumbUrl
      : buildThumbUrl(
          config,
          effectiveProtection,
          [...pathSegments, record.name],
          record.linkToken,
          record.thumbName !== null,
        );
  return {
    id: record.id,
    name: record.name,
    bytes: record.bytes,
    createdAt: record.createdAt,
    effectiveProtection,
    reason,
    previewUrl: urls.previewUrl,
    directUrl: urls.directUrl,
    thumbUrl,
    // Live-testing addition (2026-08-06): the display kind behind the row's icon. Derived server-side
    // because it needs `isText`, which lives on the record and is deliberately never exposed raw.
    kind: fileKindFor(record.name, record.isText),
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
  };
}

// D-116: `elevated` is true only for scope=visible, only for a specific target collectionId, and only
// when the viewer is independently authorized on that target by IDENTITY (owner/superuser/chain-grant -
// never the D-98 token bypass, which grants document access and the listing itself but not elevated
// breadth within it: "the token bypass stays excluded from elevation"). Reaching a non-public target (the
// gate above) does not by itself widen what its LISTING shows: without this, an owner browsing their own
// unlisted collection would still only see its `protection = 'public'` rows, because
// listVisibleFilesIn/listVisibleChildCollections' signed-in branch still only extends to public ∪ own ∪
// granted, not "every row". Collections are single-owner (D-99's grants are collection-scoped, not
// per-file - E7 owns any finer-grained sharing), so "elevated" means "show every row in this one
// collection," the same breadth listOwnedFilesIn/listAllFilesIn already give scope=mine/an admin.
//
// `viewer.isAdmin || elevated` (not folded into `elevated` itself): an admin needs `listAll*` breadth
// EVERYWHERE, including at the pseudo-root (`elevated`'s own `targetOwnerSub !== null` guard is
// structurally false there, since there is no single target collection to be elevated on) - this is what
// makes "the browser shows exactly the same two tabs for an admin" true without a client-side role branch.
// D-125 (E4.1 live-testing findings, Wave B): a third breadth between listVisible*'s absolute
// anonymous-safe floor and listAll*'s full elevated breadth - see storage/{collections,files}.ts's
// listLinkAuthorized* header comments for what it includes. `linkAuthorizedOnly` only ever applies to
// scope=visible; scope=mine and the identity-elevated/admin branches are checked first and win.
async function listChildCollections(
  scope: Scope,
  parentId: string,
  viewer: Viewer,
  elevated: boolean,
  linkAuthorizedOnly: boolean,
): Promise<CollectionRecord[]> {
  if (scope === "mine") return listOwnedChildCollections(parentId, viewer.sub!);
  if (viewer.isAdmin || elevated) return listAllChildCollections(parentId);
  if (linkAuthorizedOnly) return listLinkAuthorizedChildCollections(parentId, viewer.sub);
  return listVisibleChildCollections(parentId, viewer.sub);
}

async function listFilesFor(
  scope: Scope,
  collectionId: string,
  viewer: Viewer,
  elevated: boolean,
  linkAuthorizedOnly: boolean,
): Promise<FileRecord[]> {
  // D-126 (E4.1 live-testing findings, Wave A - partially reverses D-80): the root now holds files
  // directly, so there is no pseudo-root short-circuit here any more - every branch below already takes
  // collectionId literally, including "".
  if (scope === "mine") return listOwnedFilesIn(collectionId, viewer.sub!);
  if (viewer.isAdmin || elevated) return listAllFilesIn(collectionId);
  if (linkAuthorizedOnly) return listLinkAuthorizedFilesIn(collectionId, viewer.sub);
  return listVisibleFilesIn(collectionId, viewer.sub);
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

  const viewer: Viewer = { sub: claims?.sub ?? null, isAdmin: claims !== null && isFilesAdmin(claims) };

  let targetChain: Protection[] = [];
  let targetOwnerSub: string | null = null;
  let target: CollectionRecord | null = null;
  let breadcrumb: { id: string; name: string; previewUrl: string }[] = [];
  let pathSegments: string[] = [];
  // D-125 (renamed from A5's tokenAuthorizedOnly): true only when the target below was reached PURELY by
  // its own link - token (secret) or readable path (unlisted, D-124) - not by any identity check. See
  // reasonFor()'s header comment.
  let linkAuthorizedOnly = false;

  if (collectionId !== "") {
    target = await resolveCollectionById(collectionId);
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
    const targetEffective = mostRestrictive(targetChain);
    // D-124 (E4.1 live-testing findings, Wave B): the link shape IS the credential for public/unlisted
    // (D-59) - reachable by anyone, no identity and no token required. `secret` still needs the matching
    // token OR identity; `private` is identity only (D-99) - no token bypass exists for it.
    if (scope === "visible" && targetEffective !== "public") {
      const identityAuthorized = await isIdentityAuthorizedForTarget(target, claims);
      if (!identityAuthorized) {
        if (targetEffective === "unlisted") {
          linkAuthorizedOnly = true;
        } else {
          const rawToken = query.token;
          const suppliedToken = typeof rawToken === "string" ? rawToken : null;
          if (targetEffective === "private" || suppliedToken === null || suppliedToken !== target.linkToken) {
            reply.code(404).send();
            return;
          }
          linkAuthorizedOnly = true;
        }
      }
    }
    // E7-QA1 §A1.5: shared with controllers/preview.ts's PreviewContext.ancestors - one builder, so the
    // two can never independently drift on the D-100 secret-ancestor redaction below.
    breadcrumb = await buildBreadcrumb(config, collectionId, targetChain, claims);
    pathSegments = breadcrumb.map((crumb) => crumb.name);
  }

  // D-189: a page-level fact, computed once - true only when the viewer owns the TARGET collection being
  // browsed. `targetOwnerSub` is null at the pseudo-root (there is no single collection to host anything),
  // so this is structurally false there.
  const hostedInOwnCollection = viewer.sub !== null && targetOwnerSub !== null && viewer.sub === targetOwnerSub;
  const grants: PageGrants = { ...(await resolvePageGrants(collectionId, viewer)), linkAuthorizedOnly, hostedInOwnCollection };
  // See listChildCollections'/listFilesFor's header comment - this is the SAME identity list
  // isIdentityAuthorizedForTarget already used for the reachability gate above (owner/superuser/chain-
  // grant), minus the token bypass (a bare token authorizes this one document/listing, not elevated
  // visibility into every row it contains) and minus isAdmin (handled separately at the call site, since
  // it must also apply at the pseudo-root where there is no single target to be "elevated" on).
  const elevatedAccess =
    scope === "visible" &&
    targetOwnerSub !== null &&
    (viewer.sub === targetOwnerSub || (claims !== null && isSuperuser(claims)) || grants.chainGranted);

  // C4 (E4.1 live-testing findings, Wave C): may THIS viewer upload into the collection being listed? The
  // client must not infer this from the user object (D-116's lesson) - the server decides and hands it
  // over on the browse response, so Wave G's collection-page upload box knows whether to render at all.
  //
  // E7-QA1 §A2.2/D-196: the root still requires files:write (it holds no ACL rows at all, D-126, so a
  // can_upload grant has nowhere to live there). A SPECIFIC collection no longer requires files:write -
  // canUploadTo's own can_upload=1 ACL row is now sufficient on its own, which is what makes an invite
  // minted with only files:read (D-191) actually able to upload into the collection it was granted on.
  const canUpload =
    claims !== null && (target === null ? can(claims, "files:write") : await canUploadTo(target, claims));

  // E7-QA1 §C1 (F6): owner or superuser of the SPECIFIC collection being browsed - never true at the root
  // (targetOwnerSub is null there, D-126: no single collection to share) and never true for a mere
  // can_upload grantee (D-187: a grantee never shares). Deliberately NOT `elevatedAccess`, which also
  // widens for a chain ACL grant - sharing authority does not follow the same rule as browse breadth.
  const canManage =
    claims !== null && targetOwnerSub !== null && (viewer.sub === targetOwnerSub || isSuperuser(claims));

  const [childCollections, files] = await Promise.all([
    listChildCollections(scope, collectionId, viewer, elevatedAccess, linkAuthorizedOnly),
    listFilesFor(scope, collectionId, viewer, elevatedAccess, linkAuthorizedOnly),
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
    canUpload,
    canManage,
  };
  reply.send(response);
}
