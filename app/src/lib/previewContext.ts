// D-72/D-74: the single shape the server embeds in the document, the API returns, and the SPA renders.
// Pure and I/O-free (technical-baseline.md §2) - it only maps an already-resolved FileRecord + urls into
// the context; storage/resolution stays in storage/files.ts, urls stay in lib/fileUrls.ts.

import type { ResolvedFile } from "../storage/files.ts";
import type { Protection } from "./protection.ts";
import { isInlineAllowed, mimeTypeFor } from "./mime.ts";
import { mediaKindByExtension } from "./media.ts";

export type PreviewKind = "image" | "video" | "pdf" | "text" | "other";

// Written exactly as specified in the waves hand-off (§1) - Wave B2 (the SPA) codes against this shape
// in parallel and must not have to guess.
export type PreviewContext = {
  id: string; // the file's surrogate id (D-81) - what the E3 manage API (PATCH/DELETE /api/files/:id) addresses
  collectionId: string; // the owning collection's id - what ManageControls needs for the destination picker
  name: string; // DISPLAY name (D-82: renameable, independent of the on-disk name), for the title and og:title
  path: string; // display path (collection names + file name) - for URLs and display, NOT an identity (D-81)
  bytes: number;
  sizeLabel: string; // humanised, e.g. "2.4 MB"
  protection: Protection; // the EFFECTIVE level (D-96), never the stored column - see buildPreviewContext
  createdAt: string; // ISO 8601, from files.created_at
  previewUrl: string; // files.mosni.dev/f/<path> or /t/<token>
  directUrl: string; // dl.mosni.dev/<path> or /t/<token> - or a D-84 signed URL for a private file's owner
  thumbUrl: string | null; // dl.mosni.dev/thumb/<path> or /thumb/t/<token> - null when no thumbnail exists
  // (non-image/video, generation failed, or a pre-E5 file, D-137/D-138). A D-84-style signed
  // /thumb/s/<id> URL for a private file's owner, mirroring directUrl exactly.
  kind: PreviewKind;
  mimeType: string; // "image/png", "video/mp4", "application/pdf", "text/plain",
  // "application/octet-stream" for unknown
  inline: boolean; // isInlineAllowed(name) - false means "download card"
  width: number | null; // image or video pixel width
  height: number | null;
  durationSeconds: number | null; // video only
  textPreview: string | null; // .txt only: first 400 chars, sanitised
  uploaderName: string | null; // display name, or null. NEVER the sub (D-92/D-136).
  uploaderAvatarUrl: string | null; // files.-relative proxy URL (/api/avatar/<file id>), or null. NEVER
  // auth.mosni.dev/avatar/<sub> directly (D-92/D-136) - C1 (E5.1 Wave C): null exactly when there is no
  // uploaderSub at all, NOT when uploaderName is null. A file with a captured sub but no name still has
  // an avatar - only uploaderName's presence is independent (see buildPreviewContext's C4 fallback).
  isOwner: boolean; // ALWAYS false in the embedded document copy (D-75: the document is
  // anonymous). Only the API, given a Bearer, can return true.
};

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

// Binary units (1024-based), 1 decimal place once we cross into KB - "512 B", "2.4 MB", "1.1 GB". Plain
// byte counts under 1 KiB get no decimal at all ("999 B"), matching how people actually read small sizes.
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

// mediaKindByExtension already tells image/video apart (media.ts, display-only guess - D-143); pdf/text
// are read off the MIME type (mime.ts), which is itself keyed on the same "final extension" rule - reusing
// it here avoids a third copy of that parsing logic.
export function previewKindFor(filename: string): PreviewKind {
  const kind = mediaKindByExtension(filename);
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  const mime = mimeTypeFor(filename);
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/plain") return "text";
  return "other";
}

// Takes a ResolvedFile, not a bare FileRecord, deliberately: `protection` in the context it returns is the
// EFFECTIVE level (D-96), and asking for the resolved type makes `tsc` refuse any caller that has not
// walked the ancestor chain first. D-97 leaves a row stored looser than the collection above it, so the
// stored column would report a collection-gated file as `public` - to the owner's own preview page
// (PreviewCard.tsx renders this value verbatim, and ManageControls seeds its protection selector from it)
// and in the anonymous /api/preview/t/<token> body. Same landmine as `displayPathFor`, one field over.
export function buildPreviewContext(
  record: ResolvedFile,
  displayPath: string,
  urls: { previewUrl: string; directUrl: string; thumbUrl: string | null; uploaderAvatarUrl: string | null },
): PreviewContext {
  return {
    id: record.id,
    collectionId: record.collectionId,
    name: record.name,
    path: displayPath,
    bytes: record.bytes,
    sizeLabel: humanSize(record.bytes),
    protection: record.effectiveProtection,
    createdAt: record.createdAt,
    previewUrl: urls.previewUrl,
    directUrl: urls.directUrl,
    thumbUrl: urls.thumbUrl,
    kind: previewKindFor(record.name),
    mimeType: mimeTypeFor(record.name),
    inline: isInlineAllowed(record.name),
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
    // C4 (E5.1 Wave C, D-154/D-155): the structural fallback -
    //   name captured               -> show it
    //   no name AND uploader IS the owner -> show the sub (the owner's sub is not a real provider/account
    //                                        id the way a Google/EVE sub is - D-92's leak concern doesn't
    //                                        apply to it specifically)
    //   no name AND NOT the owner   -> null. NEVER the sub - gated on the claim captured at upload, never
    //                                  inferred from "the name happens to be missing" (that would leak a
    //                                  real provider+account id the first time name resolution failed).
    uploaderName: record.uploaderName ?? (record.uploaderIsOwner ? record.uploaderSub : null),
    // C1: gated on uploaderSub, NOT on uploaderName - a file with a captured sub but no name still gets an
    // avatar (PreviewCard.tsx omits only the name line, not the whole block).
    uploaderAvatarUrl: record.uploaderSub === null ? null : urls.uploaderAvatarUrl,
    textPreview: record.textPreview,
    // Always false here - this builder feeds the anonymous document copy (D-75). Only the API handler,
    // given a Bearer it can check against ownerSub/superuser/ACL, may set this true.
    isOwner: false,
  };
}

const KIND_LABELS: Record<string, string> = {
  "video/mp4": "MP4 video",
  "video/webm": "WEBM video",
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "image/gif": "GIF image",
  "image/webp": "WEBP image",
  "application/pdf": "PDF document",
  "text/plain": "Text file",
};

function kindLabel(ctx: PreviewContext): string {
  return KIND_LABELS[ctx.mimeType] ?? "File";
}

// Exported for E4.1 Wave B's browse table "added" column, which wants the same date format the preview
// card already uses rather than a second copy of this formatting.
export function formatUploadDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

const TEXT_SNIPPET_LIMIT = 200;

// The meta description / og:description / twitter:description content. A .txt file's own first line is a
// better description than its size, so it takes priority over the generic "<label> · <size> · <date>" line.
export function describeFile(ctx: PreviewContext): string {
  if (ctx.kind === "text" && ctx.textPreview !== null && ctx.textPreview.length > 0) {
    return ctx.textPreview.length > TEXT_SNIPPET_LIMIT
      ? `${ctx.textPreview.slice(0, TEXT_SNIPPET_LIMIT)}…`
      : ctx.textPreview;
  }
  return `${kindLabel(ctx)} · ${ctx.sizeLabel} · uploaded ${formatUploadDate(ctx.createdAt)}`;
}
