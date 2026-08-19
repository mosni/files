// Link shapes by protection level (preliminary-review P6, updated for D-81/D-82: URLs resolve through the
// database by DISPLAY name, not by mirroring an on-disk path):
//   public / unlisted   preview  files.mosni.dev/f/<collection>/.../<name>   direct  dl.mosni.dev/<collection>/.../<name>
//   secret              preview  files.mosni.dev/t/<token>                  direct  dl.mosni.dev/t/<token>
//   private             the path shape, but every request is auth-gated at delivery (or signed - D-84).
// Shared by the upload controller (returns both URLs after a successful upload) and the preview view
// (embeds the preview URL for click-to-copy), so the two can never disagree.

import type { Protection } from "./protection.ts";
import { readablePathResolves } from "./protection.ts";
import { signDelivery, type DeliveryScope } from "./deliverySignature.ts";

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

// --- D-84 signed delivery URLs -------------------------------------------------------------------------
//
// Extracted here (from controllers/preview.ts's withSignedDirectUrl, which was its only caller) because
// review 060/BUG-1 found the SECOND caller that should always have existed: controllers/browse.ts. A
// `private` row's readable path resolves (readablePathResolves only rejects `secret`), so the listing was
// handing out `dl.mosni.dev/<path>` and `dl.mosni.dev/thumb/<path>` for private files - URLs no <img> and
// no service-worker fetch can ever authorize, since neither carries a Bearer. The listing's thumbnails
// 401'd into broken images for the file's own owner, and "Download all" skipped every private file.
//
// Both URL shapes are signed from the SAME (fileId, expiry) pair, so a caller cannot accidentally sign one
// and not the other. `scope` is part of the signed input (review 060/SEC-5) - see lib/deliverySignature.ts.
export type SignedDeliveryUrls = { directUrl: string; thumbUrl: string | null; expiresAt: number };

// Review 060/BUG-3, first half. A signed URL is the ONLY way a private file's bytes reach its own player,
// and DELIVERY_URL_TTL_SECONDS defaults to 300 - so a private video longer than five minutes had its own
// range requests start 404ing mid-playback, and the player's error fallback offered the same dead URL as a
// download. The fix cannot be "renew the URL client-side" alone: web/src/components/VideoPreview.tsx keys
// <MediaPlayer> on the URL, so swapping it under a playing element restarts the video from zero, which is
// worse than the bug for everything shorter than the TTL.
//
// So the SERVER makes the lifetime cover the media instead. `minLifetimeSeconds` is the probed duration
// (storage/probe.ts); the URL lives at least that long plus a margin for buffering and pauses, and never
// less than the configured TTL. Capped, because a caller must not be able to mint a day-long credential by
// uploading a long file.
const SIGNED_MEDIA_MARGIN_SECONDS = 15 * 60;
const SIGNED_MAX_TTL_SECONDS = 6 * 60 * 60;

export function buildSignedDeliveryUrls(
  config: { dlOrigin: string; deliverySigningSecret: string; deliveryUrlTtlSeconds: number },
  fileId: string,
  hasThumb: boolean,
  minLifetimeSeconds: number | null = null,
  nowSeconds: number = Date.now() / 1000,
): SignedDeliveryUrls {
  const mediaLifetime =
    minLifetimeSeconds === null || !Number.isFinite(minLifetimeSeconds) || minLifetimeSeconds <= 0
      ? 0
      : Math.ceil(minLifetimeSeconds) + SIGNED_MEDIA_MARGIN_SECONDS;
  // The cap bounds the DURATION-DERIVED extension only - never the operator's own configured TTL, which
  // stays a floor. Clamping the whole result would silently shorten a deliberately-raised
  // DELIVERY_URL_TTL_SECONDS, which is the opposite of what an operator raising it asked for.
  const ttl = Math.max(config.deliveryUrlTtlSeconds, Math.min(SIGNED_MAX_TTL_SECONDS, mediaLifetime));
  const expiresAt = Math.floor(nowSeconds) + ttl;
  const sign = (scope: DeliveryScope) => signDelivery(config.deliverySigningSecret, fileId, expiresAt, scope);
  return {
    directUrl: `${config.dlOrigin}/s/${fileId}?exp=${expiresAt}&sig=${sign("full")}`,
    thumbUrl: hasThumb ? `${config.dlOrigin}/thumb/s/${fileId}?exp=${expiresAt}&sig=${sign("thumb")}` : null,
    expiresAt,
  };
}
