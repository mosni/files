// E5 Wave H (D-140): the embeddable player route. A minimal document - no app chrome, no header, no auth
// SDK (see web/embed.html / storage/embedShell.ts) - rendering the Wave F video player for exactly one
// file, designed to be iframed by `twitter:card=player` (PreviewHead.tsx).
//
// H2's gate, deliberately STRICTER than the ordinary preview document (controllers/preview.ts):
//   - only the READABLE path is supported at all (no `/embed/t/:token`) - `secret` already never resolves
//     a readable path (D-59/readablePathResolves), so there is no token-shaped case to reject separately;
//   - `private` DOES resolve a readable path in the ordinary sense (a private file's preview page 200s
//     anonymously, revealing nothing - D-72/D-75), so it needs an EXPLICIT reject here, since "reveal
//     nothing" is not the same guarantee as "must never render a player" (D-140: "private and secret files
//     must never render here" - the last place a gating mistake should live);
//   - only `kind === "video"` files are embeddable at all - this route exists to serve Wave F's player, and
//     nothing else.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { buildFileUrls } from "../lib/fileUrls.ts";
import { safeSegments } from "../lib/paths.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { buildPreviewContext, previewKindFor } from "../lib/previewContext.ts";
import { resolveByNames, resolveEffective, type ResolvedFile } from "../storage/files.ts";
import { collectionPath } from "../storage/collections.ts";
import { getEmbedShell } from "../storage/embedShell.ts";
import { embedContentSecurityPolicy } from "../lib/csp.ts";
import { injectHead } from "../lib/shellHtml.ts";
import { renderEmbedHead } from "../views/EmbedHead.tsx";
import { renderEmbeddedContext } from "../views/PreviewHead.tsx";
import { renderNotFoundPage } from "../views/NotFound.tsx";

function send404(reply: FastifyReply): void {
  reply.code(404).type("text/html; charset=utf-8").send(renderNotFoundPage());
}

async function resolveEmbeddable(segments: readonly string[]): Promise<ResolvedFile | null> {
  const record = await resolveByNames(segments);
  if (record === null) return null;
  const resolved = await resolveEffective(record);
  if (!readablePathResolves(resolved.effectiveProtection)) return null; // secret: never resolves here
  if (resolved.effectiveProtection === "private") return null; // H2: private never renders here, either
  if (previewKindFor(resolved.name) !== "video") return null; // this route is the Wave F video player only
  return resolved;
}

export async function embedByPath(
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

  const resolved = await resolveEmbeddable(segments);
  if (resolved === null) {
    send404(reply);
    return;
  }

  const displaySegments = [...(await collectionPath(resolved.collectionId)), resolved.name];
  const urls = {
    ...buildFileUrls(config, resolved.effectiveProtection, displaySegments, resolved.linkToken),
    // Thumbnails/avatar are irrelevant to a bare video player - never constructed for this route.
    thumbUrl: null,
    uploaderAvatarUrl: null,
  };
  const ctx = buildPreviewContext(resolved, displaySegments.join("/"), urls);
  const head = renderEmbedHead(ctx) + renderEmbeddedContext(ctx, request.url);
  // H2: overrides helmet's globally-registered CSP for THIS response only, widening frame-ancestors to the
  // named platform origins - set here, after helmet's onRequest-time default already ran, so this later
  // write wins. Every other route is untouched (verified in security-headers.test.ts).
  reply.header("Content-Security-Policy", embedContentSecurityPolicy());
  reply.type("text/html; charset=utf-8").send(injectHead(getEmbedShell(), head));
}
