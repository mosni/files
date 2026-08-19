// Preview logic for files.mosni.dev (preliminary-review P2). D-70/D-72: the server renders only the
// <head> - a rich unfurl block for crawlers, which do not run JavaScript - and splices it into the SPA's
// built shell. The file's context is embedded as JSON in that same document (zero round trips on first
// paint) and served from /api/preview/... for client-side navigation, session-aware state, and `private`
// files, which the anonymous document can never describe (D-75).

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { can, isSuperuser, type Claims } from "../lib/roles.ts";
import { buildFileUrls, buildSignedDeliveryUrls, buildThumbUrl } from "../lib/fileUrls.ts";
import { safeSegments } from "../lib/paths.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { buildPreviewContext, previewKindFor, type PreviewContext } from "../lib/previewContext.ts";
import { buildBreadcrumb } from "../lib/breadcrumb.ts";
import { canSeeCollection, canSeeFile } from "../lib/accessVisibility.ts";
import { injectHead } from "../lib/shellHtml.ts";
import type { CollectionLocation } from "../lib/browseContext.ts";
import {
  resolveByNames,
  resolveByToken,
  resolveEffective,
  type FileRecord,
  type ResolvedFile,
} from "../storage/files.ts";
import {
  collectionPath,
  hasAclGrantOnChain,
  protectionChain,
  resolveCollectionById,
  resolveCollectionByNames,
  resolveCollectionByToken,
  resolveCollectionEffective,
  type ResolvedCollection,
} from "../storage/collections.ts";
import { getSpaShell } from "../storage/spaShell.ts";
import {
  renderCollectionHead,
  renderEmbeddedCollectionLocation,
  renderEmbeddedContext,
  renderPreviewHead,
} from "../views/PreviewHead.tsx";
import { renderNotFoundPage } from "../views/NotFound.tsx";

function send404(reply: FastifyReply): void {
  reply.code(404).type("text/html; charset=utf-8").send(renderNotFoundPage());
}

// `secret` must 404 at its readable path, not 403 (D-59) - a 403 confirms existence, which is the one
// thing the level exists to hide. The token path bypasses this gate entirely (it is exactly how a
// `secret` file is reached). Gated on the EFFECTIVE level (D-96/D-100): a file whose own stored level
// would resolve here must still 404 if its collection's effective level does not.
async function resolveDocumentByNames(segments: readonly string[]): Promise<ResolvedFile | null> {
  const record = await resolveByNames(segments);
  if (record === null) return null;
  const resolved = await resolveEffective(record);
  if (!readablePathResolves(resolved.effectiveProtection)) return null;
  return resolved;
}

// E7-QA1 §A1.1 (F8): a `/f/<...>` path that names a COLLECTION, resolved for the DOCUMENT route only - a
// top-level browser navigation, which carries NO Authorization header (the auth SDK's token lives in JS
// that has not run yet when the document is requested). The old single resolver applied an identity gate
// here too, which made every private-collection deep link 404 for everyone, including its own owner,
// since E4 - `claimsFromBearer` always returned null on a headerless request. This function therefore
// applies NO identity gate at all, exactly matching how a private FILE's document route already behaves
// (D-72/D-75: reveal nothing, defer the real decision to the API). `secret` still 404s for everyone here
// (readablePathResolves rejects it) - the token path is its only way in, unchanged.
async function resolveCollectionForDocument(segments: readonly string[]): Promise<ResolvedCollection | null> {
  const record = await resolveCollectionByNames(segments);
  if (record === null) return null;
  const resolved = await resolveCollectionEffective(record);
  if (!readablePathResolves(resolved.effectiveProtection)) return null;
  return resolved;
}

// D-107/§1.2: authorization for a collection reached via its READABLE /f/ path, now checked ONLY here - at
// the API layer (`/api/preview/...`, a client-side XHR that DOES carry a bearer once the SPA has mounted
// and the auth SDK has resolved). D-99's identity list (owner, superuser, or an ACL grant anywhere on its
// own chain - lib/accessVisibility.ts's canSeeCollection). Unlike a file's `private`, which still 200s an
// anonymous requester a minimal, reveal-nothing shell, a collection route mounts the real browser and
// there is no useful "reveal nothing" shell for the API to hand back either - so a non-public collection
// 404s outright here for anyone not on that list, and the SPA falls back to its own not-found state.
async function collectionApiAuthorized(
  request: FastifyRequest,
  config: Config,
  resolved: ResolvedCollection,
): Promise<boolean> {
  // D-124 (E4.1 live-testing findings, Wave B): the link shape IS the credential for public/unlisted
  // (D-59) - "not listed, but the link works for anyone who has it" is exactly what `unlisted` means, and
  // the FILE half of this app already honours that (readablePathResolves() allows it through).
  // ⚠ Accepted cost (D-127, Hannah, 2026-07-30): collection names are user-supplied and therefore
  // guessable, so guessing an `unlisted` collection's name reveals its unlisted contents - consistent with
  // the posture already recorded for files (session 007: co-mingled unlisted files are mutually
  // path-guessable). `secret` and `private` are unaffected by this branch.
  if (resolved.effectiveProtection === "public" || resolved.effectiveProtection === "unlisted") return true;
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) return false;
  return canSeeCollection(claims, resolved);
}

// The collection counterpart of resolveDocumentByNames above, for the API layer only (§A1.1). `secret`
// 404s for everyone here, same as a file (D-59/D-99) - the token path below is the only way in for it.
async function resolveCollectionForApi(
  request: FastifyRequest,
  config: Config,
  segments: readonly string[],
): Promise<ResolvedCollection | null> {
  const record = await resolveCollectionByNames(segments);
  if (record === null) return null;
  const resolved = await resolveCollectionEffective(record);
  if (!readablePathResolves(resolved.effectiveProtection)) return null;
  if (!(await collectionApiAuthorized(request, config, resolved))) return null;
  return resolved;
}

// The display path (collection names + file's own display name) - what buildFileUrls and PreviewContext
// need. Recomputed from the current DB state on every read, never stored (D-82: a rename is a pure DB
// operation and must be reflected immediately).
//
// D-100: when the file's EFFECTIVE protection does not resolve at a readable path (secret itself, or
// gated only by an ancestor collection), the collection segments are exactly what would leak - this
// falls back to just the file's own name, mirroring what buildFileUrls already does for the URLs. Every
// PreviewContext (document, API, oEmbed) goes through this one function, so the redaction cannot be
// forgotten by a second call site reading collectionPath() directly.
async function displayPathFor(record: ResolvedFile): Promise<string[]> {
  if (!readablePathResolves(record.effectiveProtection)) return [record.name];
  const collectionSegments = await collectionPath(record.collectionId);
  return [...collectionSegments, record.name];
}

// D-137/D-136: bundles buildFileUrls with its thumbnail and avatar counterparts so every PreviewContext
// call site builds every URL the same way, rather than three copies of the same null-guard logic.
function previewUrlsFor(
  config: Config,
  record: ResolvedFile,
  segments: readonly string[],
): { previewUrl: string; directUrl: string; thumbUrl: string | null; uploaderAvatarUrl: string | null } {
  return {
    ...buildFileUrls(config, record.effectiveProtection, segments, record.linkToken),
    thumbUrl: buildThumbUrl(config, record.effectiveProtection, segments, record.linkToken, record.thumbName !== null),
    // D-169 (reverses D-92/D-136's files.-relative-proxy rule): auth.mosni.dev/avatar/<sub> directly -
    // Hannah's call, the proxy added nothing once D-168 already shows the raw sub as text. null when there
    // is no uploaderSub to build a URL from; buildPreviewContext gates on the same field again for C1.
    uploaderAvatarUrl:
      record.uploaderSub === null ? null : `${config.authIssuer}/avatar/${encodeURIComponent(record.uploaderSub)}`,
  };
}

async function sendDocument(reply: FastifyReply, config: Config, record: ResolvedFile, embeddedFor: string): Promise<void> {
  const segments = await displayPathFor(record);
  const urls = previewUrlsFor(config, record, segments);
  const ctx = buildPreviewContext(record, segments.join("/"), urls);
  // D-72/D-75: a private file's document reveals nothing to an anonymous requester - no OG, no embedded
  // context, not even the filename. Only the API (given a Bearer) may describe it. Gated on the
  // EFFECTIVE level (D-96): a file gated only by its collection must reveal just as little.
  const head =
    record.effectiveProtection === "private"
      ? renderPreviewHead(null, config.appOrigin)
      : renderPreviewHead(ctx, config.appOrigin) + renderEmbeddedContext(ctx, embeddedFor);
  reply.type("text/html; charset=utf-8").send(injectHead(getSpaShell(), head));
}

// D-107/§1.2: both /f/<...> and /t/<token> resolve to a collection id, and the SPA opens the browser
// there - reusing the D-70 embedded-context splice (renderEmbeddedCollectionLocation), never a second
// delivery mechanism. E7-QA1 §A1.2/D-197: `revealName` decides which head this collection gets - a real
// title (public/unlisted readable-path, or ANY token reach - D-59/D-98's bypass IS the grant) or the same
// reveal-nothing shell a private FILE's document already uses. The embedded CollectionLocation is sent
// EITHER WAY: it is not a credential, just the id the SPA needs to even ask /api/browse (which gates on a
// real bearer) whether this viewer may see anything more.
async function sendCollectionDocument(
  reply: FastifyReply,
  config: Config,
  resolved: ResolvedCollection,
  embeddedFor: string,
  revealName: boolean,
): Promise<void> {
  const location: CollectionLocation = { kind: "collection", collectionId: resolved.id };
  const head = revealName
    ? renderCollectionHead(resolved.name, resolved.effectiveProtection === "public")
    : renderPreviewHead(null, config.appOrigin);
  reply
    .type("text/html; charset=utf-8")
    .send(injectHead(getSpaShell(), head + renderEmbeddedCollectionLocation(location, embeddedFor)));
}

export async function previewByPath(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const segments = safeSegments(relPath);
  if (segments === null) {
    send404(reply);
    return;
  }

  // §1.1: files-first resolution order - a file token/path always wins if the two namespaces ever
  // collided (they don't in practice; link tokens and collection paths are distinct spaces).
  const fileRecord = await resolveDocumentByNames(segments);
  if (fileRecord !== null) {
    await sendDocument(reply, config, fileRecord, request.url);
    return;
  }

  // F8/A1.1: no identity gate at the document layer any more - see resolveCollectionForDocument's own
  // comment. `revealName` is the ONLY place this route still distinguishes protection levels: public/
  // unlisted keep today's real title, private renders reveal-nothing (D-197's accepted consequence -
  // existence becomes probeable by name, same as a private file already is; §0.4.3).
  const collectionRecord = await resolveCollectionForDocument(segments);
  if (collectionRecord !== null) {
    await sendCollectionDocument(
      reply,
      config,
      collectionRecord,
      request.url,
      collectionRecord.effectiveProtection !== "private",
    );
    return;
  }

  send404(reply);
}

export async function previewByToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  const fileRecord = await resolveByToken(token);
  if (fileRecord !== null) {
    await sendDocument(reply, config, await resolveEffective(fileRecord), request.url);
    return;
  }

  // A collection's own token bypasses the readable-path/authorization gate entirely, same as a file's -
  // knowing the unguessable token IS the access grant (D-59/D-98). A `secret` collection resolves here.
  // A1.2: revealName is unconditionally true - reaching a collection by its own token already proved
  // whatever the token requires, exactly as a private FILE's own /t/<token> already reveals its name.
  const collectionRecord = await resolveCollectionByToken(token);
  if (collectionRecord !== null) {
    await sendCollectionDocument(reply, config, await resolveCollectionEffective(collectionRecord), request.url, true);
    return;
  }

  send404(reply);
}

// Same grant rule controllers/delivery.ts's authorizePrivate uses (owner, superuser, an explicit ACL row
// on the file, or an ACL row on any ANCESTOR COLLECTION - D-99, matched byte-for-byte for the sub,
// security invariant 6) - but this app never distinguishes 401 from 403 for a preview: an unauthorized
// request just gets the same 404 a nonexistent file would (D-72's whole point is that neither the
// document nor the API becomes an existence oracle for `private`). E7-QA1: renamed from hasElevatedAccess
// (F10/F11) - its true job is deciding VISIBILITY, whether a private file's document/context may be sent
// at all. It must never be mistaken for any of the three PreviewContext booleans below (previewBooleansFor
// computes those on its own, honest rule) - that conflation is exactly F10/F11's root cause.
// D-190: wider than manage.ts's A1.4 visibility gate on purpose. canSeeFile alone answers "does this
// viewer have a right to KNOW this file exists" (owner/superuser/ACL grant), which manage.ts's 403-vs-404
// split needs unchanged - a collection host with no grant of their own still gets a flat 404 attempting to
// rename a file they merely host (app/test/integration/manage.test.ts's D-190 block). But viewing a
// private file's context is the READ half of the same right previewBooleansFor's canDelete already grants
// the host - they may already delete this file, so denying them a look at its context first would be
// nonsensical, not extra safety.
async function canSeePrivateContent(claims: Claims, record: ResolvedFile): Promise<boolean> {
  if (await canSeeFile(claims, record)) return true;
  if (record.collectionId === "") return false;
  const collection = await resolveCollectionById(record.collectionId);
  return collection !== null && collection.ownerSub === claims.sub;
}

// E7-QA1 §1.1/A1.3 (F10/F11): the three honest PreviewContext booleans, computed once and shared between
// ownerContextFor (the manage-mutation response and the private-branch API response) and sendContext's
// non-private branch. `isOwner` is STRICT ownership - never true for a superuser or a grantee, the whole
// point of the split. `canManage` mirrors controllers/manage.ts's rename/protection/move guard exactly.
// `canDelete` mirrors its delete guard, including the D-190 collection-owner case.
async function previewBooleansFor(
  record: ResolvedFile,
  claims: Claims | null,
): Promise<{ isOwner: boolean; canManage: boolean; canDelete: boolean }> {
  if (claims === null) return { isOwner: false, canManage: false, canDelete: false };
  const isOwner = record.ownerSub !== null && claims.sub === record.ownerSub;
  const canManage = isOwner || isSuperuser(claims);
  // D-190, mirroring controllers/manage.ts's deleteFileHandler exactly: the collection's owner may delete
  // a file another account uploaded into it, and nothing else - rename/protection/move (canManage, above)
  // are deliberately unaffected.
  const viewerOwnsContainingCollection =
    record.collectionId !== "" && (await resolveCollectionById(record.collectionId))?.ownerSub === claims.sub;
  const canDelete = canManage || can(claims, "files:delete") || viewerOwnsContainingCollection;
  return { isOwner, canManage, canDelete };
}

// D-84/D-137: only an authenticated, authorized request for a `private` file gets a signed directUrl (and,
// when a thumbnail exists, a signed thumbUrl too) - never the anonymous embedded document (D-75 stands: it
// reveals nothing). Gated on the EFFECTIVE level (D-96): a file gated only by its collection needs the
// same signed-URL treatment as one stored private itself. uploaderAvatarUrl needs no signing (D-169): it
// already points straight at auth.mosni.dev's own public avatar route, not a files.mosni.dev proxy of it.
function withSignedDirectUrl(ctx: PreviewContext, config: Config, record: ResolvedFile): PreviewContext {
  if (record.effectiveProtection !== "private") return ctx;
  // The URL construction itself moved to lib/fileUrls.ts (review 060/BUG-1) so controllers/browse.ts can
  // sign a listing's private rows through the exact same code - two independent copies were how the
  // listing ended up handing out unauthorizable URLs in the first place.
  // BUG-3: a video's own duration extends the signature's lifetime, so it survives its own playback -
  // see buildSignedDeliveryUrls for why this is the server's job rather than a client-side renewal.
  const signed = buildSignedDeliveryUrls(config, record.id, record.thumbName !== null, record.durationSeconds);
  return {
    ...ctx,
    directUrl: signed.directUrl,
    thumbUrl: signed.thumbUrl,
    // BUG-3: the client needs the deadline to renew before it passes.
    directUrlExpiresAt: signed.expiresAt,
  };
}

// The context an already-authorized viewer sees: current display path, current URLs (which change shape
// when protection does - `secret` moves both links onto /t/<token>), a D-84 signed directUrl when the
// file is `private` so its bytes still render in its own preview, the honest isOwner/canManage/canDelete
// booleans (§A1.3), and the real ancestor breadcrumb (§A1.5/F12).
//
// Exported because controllers/manage.ts returns exactly this from a successful PATCH /api/files/:id.
// Both a rename and a protection change invalidate previewUrl/directUrl, and the SPA cannot recompute
// them (it never sees the link_token) - so the mutation response has to carry them, or the page keeps
// offering the URL the mutation just retired. Sharing this builder is what keeps the two answers
// identical; a second copy in manage.ts would be one refactor away from disagreeing.
//
// `claims` is now a required parameter (E7-QA1, F10/F11): ownerContextFor used to hardcode `isOwner:
// true`, which was wrong for every caller except the literal owner - a superuser or an ACL grantee got
// told they owned the file. The caller has already established SOME form of authorization (owner,
// superuser, or a grant) before calling this; it no longer guesses which.
export async function ownerContextFor(config: Config, record: FileRecord, claims: Claims): Promise<PreviewContext> {
  const resolved = await resolveEffective(record);
  const segments = await displayPathFor(resolved);
  const urls = previewUrlsFor(config, resolved, segments);
  const booleans = await previewBooleansFor(resolved, claims);
  const targetChain = await protectionChain(resolved.collectionId);
  const ancestors = await buildBreadcrumb(config, resolved.collectionId, targetChain, claims);
  const ctx: PreviewContext = {
    ...buildPreviewContext(resolved, segments.join("/"), urls),
    ...booleans,
    ancestors,
  };
  return withSignedDirectUrl(ctx, config, resolved);
}

async function sendContext(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  record: ResolvedFile | null,
): Promise<void> {
  if (record === null) {
    reply.code(404).send();
    return;
  }

  const claims = await claimsFromBearer(request, config.appOrigin);

  if (record.effectiveProtection === "private") {
    if (claims === null || !(await canSeePrivateContent(claims, record))) {
      reply.code(404).send();
      return;
    }
    reply.send(await ownerContextFor(config, record, claims));
    return;
  }

  const segments = await displayPathFor(record);
  const urls = previewUrlsFor(config, record, segments);
  const displayPath = segments.join("/");

  const ctx = buildPreviewContext(record, displayPath, urls);
  const booleans = await previewBooleansFor(record, claims);
  const targetChain = await protectionChain(record.collectionId);
  const ancestors = await buildBreadcrumb(config, record.collectionId, targetChain, claims);
  reply.send({ ...ctx, ...booleans, ancestors });
}

// E4.1 Wave C: a client-side navigation (or a back/forward that lands React Router on this route without
// a fresh document) has no embedded context to fall back on - it must resolve through this API instead,
// so it needs the SAME file-then-collection fallback the document routes (previewByPath/previewByToken)
// already have, returning CollectionLocation's shape when the target is a collection.
export async function previewContextByPath(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const segments = safeSegments(relPath);
  if (segments === null) {
    reply.code(404).send();
    return;
  }

  const fileRecord = await resolveDocumentByNames(segments);
  if (fileRecord !== null) {
    await sendContext(request, reply, config, fileRecord);
    return;
  }

  // A1.1: the API-layer resolver, which DOES carry a bearer (a client-side XHR) and is where a private
  // collection's authorization is now actually decided (F8).
  const collectionRecord = await resolveCollectionForApi(request, config, segments);
  if (collectionRecord !== null) {
    const location: CollectionLocation = { kind: "collection", collectionId: collectionRecord.id };
    reply.send(location);
    return;
  }

  reply.code(404).send();
}

export async function previewContextByToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  const fileRecord = await resolveByToken(token);
  if (fileRecord !== null) {
    await sendContext(request, reply, config, await resolveEffective(fileRecord));
    return;
  }

  // Token bypasses the readable-path/authorization gate entirely, same as the document route (D-59/D-98).
  const collectionRecord = await resolveCollectionByToken(token);
  if (collectionRecord !== null) {
    const location: CollectionLocation = { kind: "collection", collectionId: collectionRecord.id };
    reply.send(location);
    return;
  }

  reply.code(404).send();
}

function relPathFromPreviewUrl(url: string, appOrigin: string): string | null {
  const prefix = `${appOrigin}/f/`;
  if (!url.startsWith(prefix)) return null;
  try {
    return url
      .slice(prefix.length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}

function tokenFromPreviewUrl(url: string, appOrigin: string): string | null {
  const prefix = `${appOrigin}/t/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

// oEmbed 1.0 (D-74). A `private` file, an unknown file, or a `url` outside this origin all answer 404 -
// this endpoint must not become a second existence oracle alongside the document/API. The `url` query
// parameter is attacker-controlled and is never echoed back into the response.
export async function oembedForUrl(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const query = request.query as Record<string, unknown>;
  const url = typeof query.url === "string" ? query.url : null;
  if (url === null) {
    reply.code(404).send();
    return;
  }

  const relPath = relPathFromPreviewUrl(url, config.appOrigin);
  const token = relPath === null ? tokenFromPreviewUrl(url, config.appOrigin) : null;
  if (relPath === null && token === null) {
    reply.code(404).send();
    return;
  }

  const segments = relPath === null ? null : safeSegments(relPath);
  let record: ResolvedFile | null;
  if (relPath !== null) {
    record = segments === null ? null : await resolveDocumentByNames(segments);
  } else {
    const byToken = await resolveByToken(token!);
    record = byToken === null ? null : await resolveEffective(byToken);
  }
  if (record === null || record.effectiveProtection === "private") {
    reply.code(404).send();
    return;
  }

  const displaySegments = await displayPathFor(record);
  const urls = previewUrlsFor(config, record, displaySegments);
  const ctx = buildPreviewContext(record, displaySegments.join("/"), urls);
  const isPhoto = previewKindFor(record.name) === "image" && ctx.width !== null && ctx.height !== null;

  reply.send({
    version: "1.0",
    type: isPhoto ? "photo" : "link",
    provider_name: "Hannah's File Drop",
    provider_url: config.appOrigin,
    title: ctx.name,
    url: ctx.directUrl,
    // D-137 (E5, corrected in review session 034): `thumbnail_url` must prefer the actual THUMBNAIL. The
    // unfurl half of E5 repointed og:image/twitter:image at it (Wave B2) precisely so a consumer stops
    // pulling the multi-MB original, and this field - the one literally named "thumbnail" - was left on
    // directUrl. Falls back to directUrl for a pre-E5 file with no thumbnail (D-138: never backfilled).
    ...(isPhoto
      ? { width: ctx.width, height: ctx.height, thumbnail_url: ctx.thumbUrl ?? ctx.directUrl }
      : {}),
  });
}
