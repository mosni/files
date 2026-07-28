// Link shapes by protection level (preliminary-review P6, updated for D-81/D-82: URLs resolve through the
// database by DISPLAY name, not by mirroring an on-disk path):
//   public / unlisted   preview  files.mosni.dev/f/<collection>/.../<name>   direct  dl.mosni.dev/<collection>/.../<name>
//   secret              preview  files.mosni.dev/t/<token>                  direct  dl.mosni.dev/t/<token>
//   private             the path shape, but every request is auth-gated at delivery (or signed - D-84).
// Shared by the upload controller (returns both URLs after a successful upload) and the preview view
// (embeds the preview URL for click-to-copy), so the two can never disagree.

import type { Protection } from "./protection.ts";
import { readablePathResolves } from "./protection.ts";

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
