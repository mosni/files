// D-40/D-59: link shape differs by protection level. `public`/`unlisted` resolve at the readable mirrored
// path; `secret`/`private` resolve only at the token path. Shared by routes/upload.ts (returning the two
// URLs after a successful upload) and routes/preview.ts (embedding the preview URL for click-to-copy).

import type { Protection } from "./protection.ts";
import { readablePathResolves } from "./protection.ts";

export type FileUrls = { previewUrl: string; directUrl: string };

export function buildFileUrls(
  origins: { appOrigin: string; dlOrigin: string },
  protection: Protection,
  collectionName: string,
  fileName: string,
  linkToken: string,
): FileUrls {
  const readable = readablePathResolves(protection);
  const previewPath = readable
    ? `/${encodeURIComponent(collectionName)}/${encodeURIComponent(fileName)}`
    : `/f/${linkToken}`;
  const directPath = readable
    ? `/${encodeURIComponent(collectionName)}/${encodeURIComponent(fileName)}`
    : `/${linkToken}`;
  return {
    previewUrl: `${origins.appOrigin}${previewPath}`,
    directUrl: `${origins.dlOrigin}${directPath}`,
  };
}
