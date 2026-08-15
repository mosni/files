// Link shapes by protection level (preliminary-review P6, updated for D-81/D-82: URLs resolve through the
// database by DISPLAY name, not by mirroring an on-disk path):
//   public / unlisted   preview  files.mosni.dev/f/<collection>/.../<name>   direct  dl.mosni.dev/<collection>/.../<name>
//   secret              preview  files.mosni.dev/t/<token>                  direct  dl.mosni.dev/t/<token>
//   private             the path shape, but every request is auth-gated at delivery (or signed - D-84).
// Shared by the upload controller (returns both URLs after a successful upload) and the preview view
// (embeds the preview URL for click-to-copy), so the two can never disagree.

import type { Protection } from "./protection.ts";
import { readablePathResolves } from "./protection.ts";
import { signDelivery } from "./deliverySignature.ts";

export type FileUrls = { previewUrl: string; directUrl: string };

function encodeSegments(segments: readonly string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

// `pathSegments` is the collection's path (root-first, display names) followed by the file's own display
// name - i.e. exactly what `/f/...` and `dl.mosni.dev/...` mirror. A rename changes only the DB row
// (D-82), so these URLs are recomputed from current names on every read rather than stored anywhere.
export function buildFileUrls(
  origins: { appOrigin: string; dlOrigin: string },
  protection: Protection,
  pathSegments: readonly string[],
  linkToken: string,
): FileUrls {
  if (readablePathResolves(protection)) {
    const enc = encodeSegments(pathSegments);
    return {
      previewUrl: `${origins.appOrigin}/f/${enc}`,
      directUrl: `${origins.dlOrigin}/${enc}`,
    };
  }
  // secret: the readable path 404s, so both links go through the unguessable token.
  return {
    previewUrl: `${origins.appOrigin}/t/${linkToken}`,
    directUrl: `${origins.dlOrigin}/t/${linkToken}`,
  };
}

// D-137: a thumbnail's dl. URL, same shape family as directUrl above but under a `/thumb` prefix (a
// SEPARATE delivery route in controllers/delivery.ts, gated identically to the source - see B1). Null
// when the record has no thumbnail at all, so callers never construct a URL for bytes that don't exist.
export function buildThumbUrl(
  origins: { dlOrigin: string },
  protection: Protection,
  pathSegments: readonly string[],
  linkToken: string,
  hasThumb: boolean,
): string | null {
  if (!hasThumb) return null;
  if (readablePathResolves(protection)) {
    return `${origins.dlOrigin}/thumb/${encodeSegments(pathSegments)}`;
  }
  return `${origins.dlOrigin}/thumb/t/${linkToken}`;
}

// D-84/D-137: a `private` file's bytes are reachable ONLY through a short-lived signed URL. The
// path/token URLs above cannot serve one, because every route they reach runs authorizePrivate(), and
// dl.mosni.dev has no session to authorize with - D-33 forbids a cookie on that origin outright, and a
// plain `<img src>` or a cross-origin archive fetch() cannot carry a Bearer either. So for `private` the
// signature IS the authorization, and any surface that hands a private file's URLs to a browser has to
// build them here.
//
// E7-QA1 round 3 (Hannah): "the thumbnail does not load for private files ... changing it to unlisted
// fixed it". The preview page had this (controllers/preview.ts's withSignedDirectUrl); the browse LISTING
// did not, so every private row pointed its `<img>` at /thumb/<path>, which answered 401/403 to a request
// that structurally could never be authorized - the browser's broken-image icon. Shared from one place
// now precisely so the two surfaces cannot drift apart again.
//
// ⚠ Minting these is granting byte access for the whole TTL: only ever call this for a viewer already
// authorized to read the file. Both callers satisfy that - the preview builds them only in its
// already-authorized owner context, and a `private` row reaches the listing only through
// listOwnedFilesIn/listVisibleFilesIn's identity branch or the admin branch (a link-authorized listing
// excludes `private` outright, D-99).
export function buildSignedDeliveryUrls(
  config: { dlOrigin: string; deliverySigningSecret: string; deliveryUrlTtlSeconds: number },
  fileId: string,
  hasThumb: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { directUrl: string; thumbUrl: string | null } {
  const expiresAt = nowSeconds + config.deliveryUrlTtlSeconds;
  const sig = signDelivery(config.deliverySigningSecret, fileId, expiresAt);
  const query = `?exp=${expiresAt}&sig=${sig}`;
  return {
    directUrl: `${config.dlOrigin}/s/${fileId}${query}`,
    // The signature covers the fileId, not anything thumbnail-specific, so the same one authorizes both.
    thumbUrl: hasThumb ? `${config.dlOrigin}/thumb/s/${fileId}${query}` : null,
  };
}

// D-98: a collection's own share link, same shape as a file's previewUrl - collections have no bytes of
// their own, so there is no equivalent of directUrl. Used by the browse API (controllers/browse.ts) for
// each listed collection row.
export function buildCollectionPreviewUrl(
  origins: { appOrigin: string },
  protection: Protection,
  pathSegments: readonly string[],
  linkToken: string,
): string {
  if (readablePathResolves(protection)) {
    return `${origins.appOrigin}/f/${encodeSegments(pathSegments)}`;
  }
  return `${origins.appOrigin}/t/${linkToken}`;
}
