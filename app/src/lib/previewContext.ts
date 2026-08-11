// D-72/D-74: the single shape the server embeds in the document, the API returns, and the SPA renders.
// Pure and I/O-free (technical-baseline.md §2) - it only maps an already-resolved FileRecord + urls into
// the context; storage/resolution stays in storage/files.ts, urls stay in lib/fileUrls.ts.

import type { ResolvedFile } from "../storage/files.ts";
import type { Protection } from "./protection.ts";
import { contentTypeForRecord, isInlineAllowed, isInlineAllowedFor, mimeTypeFor } from "./mime.ts";
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
  uploaderName: string | null; // display name, or the sub itself as an unconditional fallback (D-168 -
  // see buildPreviewContext). null only when there is no uploaderSub at all.
  uploaderAvatarUrl: string | null; // auth.mosni.dev/avatar/<sub> DIRECTLY (D-169, reverses D-92/D-136's
  // proxy-only rule - now moot since D-168 already shows the raw sub as text whenever there is no name).
  // C1 (E5.1 Wave C): null exactly when there is no uploaderSub at all, NOT when uploaderName is null. A
  // file with a captured sub but no name still has an avatar - only uploaderName's presence is independent
  // (see buildPreviewContext's D-168 fallback).
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
// Live-testing 2026-08-06 (Hannah): textness comes from the BYTES, so this takes the detected flag
// alongside the name rather than deriving everything from the filename. Image/video/pdf stay
// name-derived (media.ts's display-only guess, D-143) - only the text answer changed, which is what was
// actually asked for. `isText` is checked AFTER image/video so a real photo is never demoted to a code
// block by a stray detection, and BEFORE the extension's own text mapping so it can never be narrowed
// back down to an allowlist.
export function previewKindFor(filename: string, isText = false): PreviewKind {
  const kind = mediaKindByExtension(filename);
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (isText) return "text";
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
    kind: previewKindFor(record.name, record.isText),
    // Both from the same record-aware helpers delivery uses, so the page's own idea of the file can never
    // disagree with the headers its bytes actually arrive under (live-testing 2026-08-06).
    mimeType: contentTypeForRecord(record),
    inline: isInlineAllowedFor(record),
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
    // D-168 (E5.1 live-testing round 4, reverses D-155's "owner only" framing): Hannah's exact words,
    // unconditional, no platform-based exception - "name -> sub as fallback". Name captured -> show it.
    // No name -> show the sub. That's the whole rule.
    uploaderName: record.uploaderName ?? record.uploaderSub,
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

// E5.1 live-testing round 2: the preview page's "uploaded <when> by <who>" line, in the VIEWER'S OWN local
// time (Hannah's explicit call, round 2) - a sortable "YYYY-MM-DD HH:MM" shape, zero-padded, no UTC
// label. Deliberately NOT the same reasoning as `formatUploadDate` (which stays UTC): that one is read by
// BOTH server-rendered output (the embedded document copy, D-75) and the client, so "the server does not
// know the viewer's timezone" genuinely applies there. This function is called ONLY from PreviewCard.tsx,
// a client component - `new Date(iso)`'s local getters ARE the viewer's own browser timezone here, so
// there is no server/client ambiguity to route around. Never call this from server-rendered code (the
// embedded-document builder, `describeFile`, etc.) - it would silently report the SERVER's timezone as if
// it were the viewer's.
export function formatUploadDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date} ${time}`;
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
