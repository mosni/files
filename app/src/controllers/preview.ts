// Preview logic for files.mosni.dev (preliminary-review P2). D-70/D-72: the server renders only the
// <head> - a rich unfurl block for crawlers, which do not run JavaScript - and splices it into the SPA's
// built shell. The file's context is embedded as JSON in that same document (zero round trips on first
// paint) and served from /api/preview/... for client-side navigation, session-aware state, and `private`
// files, which the anonymous document can never describe (D-75).

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { isSuperuser } from "../lib/roles.ts";
import { buildFileUrls } from "../lib/fileUrls.ts";
import { safeSegments } from "../lib/paths.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { buildPreviewContext, previewKindFor, type PreviewContext } from "../lib/previewContext.ts";
import { signDelivery } from "../lib/deliverySignature.ts";
import { injectHead } from "../lib/shellHtml.ts";
import {
  hasAclGrant,
  resolveByNames,
  resolveByToken,
  resolveEffective,
  type FileRecord,
  type ResolvedFile,
} from "../storage/files.ts";
import { collectionPath, hasAclGrantOnChain } from "../storage/collections.ts";
import { getSpaShell } from "../storage/spaShell.ts";
import { renderEmbeddedContext, renderPreviewHead } from "../views/PreviewHead.tsx";
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

async function sendDocument(reply: FastifyReply, config: Config, record: ResolvedFile): Promise<void> {
  const segments = await displayPathFor(record);
  const urls = buildFileUrls(config, record.effectiveProtection, segments, record.linkToken);
  const ctx = buildPreviewContext(record, segments.join("/"), urls);
  // D-72/D-75: a private file's document reveals nothing to an anonymous requester - no OG, no embedded
  // context, not even the filename. Only the API (given a Bearer) may describe it. Gated on the
  // EFFECTIVE level (D-96): a file gated only by its collection must reveal just as little.
  const head =
    record.effectiveProtection === "private"
      ? renderPreviewHead(null, config.appOrigin)
      : renderPreviewHead(ctx, config.appOrigin) + renderEmbeddedContext(ctx);
  reply.type("text/html; charset=utf-8").send(injectHead(getSpaShell(), head));
}

export async function previewByPath(
  _request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const segments = safeSegments(relPath);
  const record = segments === null ? null : await resolveDocumentByNames(segments);
  if (record === null) {
    send404(reply);
    return;
  }
  await sendDocument(reply, config, record);
}

export async function previewByToken(
  _request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  const record = await resolveByToken(token);
  if (record === null) {
    send404(reply);
    return;
  }
  await sendDocument(reply, config, await resolveEffective(record));
}

// Same grant rule controllers/delivery.ts's authorizePrivate uses (owner, superuser, an explicit ACL row
// on the file, or an ACL row on any ANCESTOR COLLECTION - D-99, matched byte-for-byte for the sub,
// security invariant 6) - but this app never distinguishes 401 from 403 for a preview: an unauthorized
// request just gets the same 404 a nonexistent file would (D-72's whole point is that neither the
// document nor the API becomes an existence oracle for `private`).
async function hasElevatedAccess(
  request: FastifyRequest,
  config: Config,
  record: ResolvedFile,
): Promise<boolean> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) return false;
  const isOwner = record.ownerSub !== null && claims.sub === record.ownerSub;
  return (
    isOwner ||
    isSuperuser(claims) ||
    (await hasAclGrant(record.id, claims.sub)) ||
    (await hasAclGrantOnChain(record.collectionId, claims.sub))
  );
}

// D-84: only an authenticated, authorized request for a `private` file gets a signed directUrl - never
// the anonymous embedded document (D-75 stands: it reveals nothing). Gated on the EFFECTIVE level (D-96):
// a file gated only by its collection needs the same signed-URL treatment as one stored private itself.
function withSignedDirectUrl(ctx: PreviewContext, config: Config, record: ResolvedFile): PreviewContext {
  if (record.effectiveProtection !== "private") return ctx;
  const expiresAt = Math.floor(Date.now() / 1000) + config.deliveryUrlTtlSeconds;
  const sig = signDelivery(config.deliverySigningSecret, record.id, expiresAt);
  return { ...ctx, directUrl: `${config.dlOrigin}/s/${record.id}?exp=${expiresAt}&sig=${sig}` };
}

// The context an already-authorized owner sees: current display path, current URLs (which change shape
// when protection does - `secret` moves both links onto /t/<token>), and a D-84 signed directUrl when the
// file is `private`, so its bytes still render in its own preview.
//
// Exported because controllers/manage.ts returns exactly this from a successful PATCH /api/files/:id.
// Both a rename and a protection change invalidate previewUrl/directUrl, and the SPA cannot recompute
// them (it never sees the link_token) - so the mutation response has to carry them, or the page keeps
// offering the URL the mutation just retired. Sharing this builder is what keeps the two answers
// identical; a second copy in manage.ts would be one refactor away from disagreeing.
export async function ownerContextFor(config: Config, record: FileRecord): Promise<PreviewContext> {
  const resolved = await resolveEffective(record);
  const segments = await displayPathFor(resolved);
  const urls = buildFileUrls(config, resolved.effectiveProtection, segments, record.linkToken);
  const ctx: PreviewContext = {
    ...buildPreviewContext(resolved, segments.join("/"), urls),
    isOwner: true,
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

  if (record.effectiveProtection === "private") {
    const granted = await hasElevatedAccess(request, config, record);
    if (!granted) {
      reply.code(404).send();
      return;
    }
    reply.send(await ownerContextFor(config, record));
    return;
  }

  const segments = await displayPathFor(record);
  const urls = buildFileUrls(config, record.effectiveProtection, segments, record.linkToken);
  const displayPath = segments.join("/");

  const ctx = buildPreviewContext(record, displayPath, urls);
  const isOwner = await hasElevatedAccess(request, config, record);
  reply.send({ ...ctx, isOwner });
}

export async function previewContextByPath(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const segments = safeSegments(relPath);
  const record = segments === null ? null : await resolveDocumentByNames(segments);
  await sendContext(request, reply, config, record);
}

export async function previewContextByToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  const record = await resolveByToken(token);
  await sendContext(request, reply, config, record === null ? null : await resolveEffective(record));
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
  const urls = buildFileUrls(config, record.effectiveProtection, displaySegments, record.linkToken);
  const ctx = buildPreviewContext(record, displaySegments.join("/"), urls);
  const isPhoto = previewKindFor(record.name) === "image" && ctx.width !== null && ctx.height !== null;

  reply.send({
    version: "1.0",
    type: isPhoto ? "photo" : "link",
    provider_name: "Hannah's File Drop",
    provider_url: config.appOrigin,
    title: ctx.name,
    url: ctx.directUrl,
    ...(isPhoto ? { width: ctx.width, height: ctx.height, thumbnail_url: ctx.directUrl } : {}),
  });
}
