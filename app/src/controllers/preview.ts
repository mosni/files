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
import { readablePathResolves } from "../lib/protection.ts";
import { buildPreviewContext, previewKindFor, type PreviewContext } from "../lib/previewContext.ts";
import { injectHead } from "../lib/shellHtml.ts";
import { hasAclGrant, resolveByPath, resolveByToken, type FileRecord } from "../storage/files.ts";
import { getSpaShell } from "../storage/spaShell.ts";
import { renderEmbeddedContext, renderPreviewHead } from "../views/PreviewHead.tsx";
import { renderNotFoundPage } from "../views/NotFound.tsx";

function send404(reply: FastifyReply): void {
  reply.code(404).type("text/html; charset=utf-8").send(renderNotFoundPage());
}

// `secret` must 404 at its readable path, not 403 (D-59) - a 403 confirms existence, which is the one
// thing the level exists to hide. The token path bypasses this gate entirely (it is exactly how a
// `secret` file is reached).
async function resolveDocumentByPath(relPath: string): Promise<FileRecord | null> {
  const record = await resolveByPath(relPath);
  if (record !== null && !readablePathResolves(record.protection)) return null;
  return record;
}

function sendDocument(reply: FastifyReply, config: Config, record: FileRecord): void {
  const urls = buildFileUrls(config, record.protection, record.path, record.linkToken);
  const ctx = buildPreviewContext(record, urls);
  // D-72/D-75: a private file's document reveals nothing to an anonymous requester - no OG, no embedded
  // context, not even the filename. Only the API (given a Bearer) may describe it.
  const head =
    record.protection === "private"
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
  const record = await resolveDocumentByPath(relPath);
  if (record === null) {
    send404(reply);
    return;
  }
  sendDocument(reply, config, record);
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
  sendDocument(reply, config, record);
}

// Same grant rule controllers/delivery.ts's authorizePrivate uses (owner, superuser, or an explicit ACL
// row, matched byte-for-byte - security invariant 6) - but this app never distinguishes 401 from 403 for
// a preview: an unauthorized request just gets the same 404 a nonexistent file would (D-72's whole point
// is that neither the document nor the API becomes an existence oracle for `private`).
async function hasElevatedAccess(
  request: FastifyRequest,
  config: Config,
  record: FileRecord,
): Promise<boolean> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) return false;
  const isOwner = record.ownerSub !== null && claims.sub === record.ownerSub;
  return isOwner || isSuperuser(claims) || (await hasAclGrant(record.path, claims.sub));
}

async function sendContext(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  record: FileRecord | null,
): Promise<void> {
  if (record === null) {
    reply.code(404).send();
    return;
  }

  if (record.protection === "private") {
    const granted = await hasElevatedAccess(request, config, record);
    if (!granted) {
      reply.code(404).send();
      return;
    }
    const urls = buildFileUrls(config, record.protection, record.path, record.linkToken);
    const ctx: PreviewContext = { ...buildPreviewContext(record, urls), isOwner: true };
    reply.send(ctx);
    return;
  }

  const urls = buildFileUrls(config, record.protection, record.path, record.linkToken);
  const ctx = buildPreviewContext(record, urls);
  const isOwner = await hasElevatedAccess(request, config, record);
  reply.send({ ...ctx, isOwner });
}

export async function previewContextByPath(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  relPath: string,
): Promise<void> {
  const record = await resolveDocumentByPath(relPath);
  await sendContext(request, reply, config, record);
}

export async function previewContextByToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  token: string,
): Promise<void> {
  const record = await resolveByToken(token);
  await sendContext(request, reply, config, record);
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

  const record = relPath !== null ? await resolveDocumentByPath(relPath) : await resolveByToken(token!);
  if (record === null || record.protection === "private") {
    reply.code(404).send();
    return;
  }

  const urls = buildFileUrls(config, record.protection, record.path, record.linkToken);
  const ctx = buildPreviewContext(record, urls);
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
