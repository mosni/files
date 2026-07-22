// D-72/D-74: the single shape the server embeds in the document, the API returns, and the SPA renders.
// Pure and I/O-free (technical-baseline.md §2) - it only maps an already-resolved FileRecord + urls into
// the context; storage/resolution stays in storage/files.ts, urls stay in lib/fileUrls.ts.

import type { FileRecord } from "../storage/files.ts";
import type { Protection } from "./protection.ts";
import { isInlineAllowed, mimeTypeFor } from "./mime.ts";
import { stripStrategyFor } from "./media.ts";

export type PreviewKind = "image" | "video" | "pdf" | "text" | "other";

// Written exactly as specified in the waves hand-off (§1) - Wave B2 (the SPA) codes against this shape
// in parallel and must not have to guess.
export type PreviewContext = {
  name: string; // basename, for the title and og:title
  path: string; // relative path from STORAGE_ROOT - the file's identity
  bytes: number;
  sizeLabel: string; // humanised, e.g. "2.4 MB"
  protection: Protection;
  createdAt: string; // ISO 8601, from files.created_at
  previewUrl: string; // files.mosni.dev/f/<path> or /t/<token>
  directUrl: string; // dl.mosni.dev/<path> or /t/<token>
  kind: PreviewKind;
  mimeType: string; // "image/png", "video/mp4", "application/pdf", "text/plain",
  // "application/octet-stream" for unknown
  inline: boolean; // isInlineAllowed(name) - false means "download card"
  width: number | null; // image or video pixel width
  height: number | null;
  durationSeconds: number | null; // video only
  textPreview: string | null; // .txt only: first 400 chars, sanitised
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

// stripStrategyFor already tells image/video apart (media.ts); pdf/text are read off the MIME type
// (mime.ts), which is itself keyed on the same "final extension" rule - reusing it here avoids a third
// copy of that parsing logic.
export function previewKindFor(filename: string): PreviewKind {
  const strategy = stripStrategyFor(filename);
  if (strategy === "image") return "image";
  if (strategy === "video") return "video";
  const mime = mimeTypeFor(filename);
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/plain") return "text";
  return "other";
}

export function buildPreviewContext(
  record: FileRecord,
  urls: { previewUrl: string; directUrl: string },
): PreviewContext {
  return {
    name: record.name,
    path: record.path,
    bytes: record.bytes,
    sizeLabel: humanSize(record.bytes),
    protection: record.protection,
    createdAt: record.createdAt,
    previewUrl: urls.previewUrl,
    directUrl: urls.directUrl,
    kind: previewKindFor(record.name),
    mimeType: mimeTypeFor(record.name),
    inline: isInlineAllowed(record.name),
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
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

function formatUploadDate(iso: string): string {
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
