// Link shapes by protection level (preliminary-review P6). URLs mirror the on-disk relative path:
//   public / unlisted   preview  files.mosni.dev/f/<path>      direct  dl.mosni.dev/<path>
//   secret              preview  files.mosni.dev/t/<token>     direct  dl.mosni.dev/t/<token>
//   private             the path shape, but every request is auth-gated at delivery.
// Shared by the upload controller (returns both URLs after a successful upload) and the preview view
// (embeds the preview URL for click-to-copy), so the two can never disagree.

import type { Protection } from "./protection.ts";
import { readablePathResolves } from "./protection.ts";

export type FileUrls = { previewUrl: string; directUrl: string };

// Encode each segment but keep the slashes as real path separators.
function encodeRelPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

export function buildFileUrls(
  origins: { appOrigin: string; dlOrigin: string },
  protection: Protection,
  relPath: string,
  linkToken: string,
): FileUrls {
  if (readablePathResolves(protection)) {
    const enc = encodeRelPath(relPath);
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
