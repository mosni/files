// Security invariant 3 (technical-baseline.md §1): anything not on this allowlist is served
// `Content-Disposition: attachment`. Fail closed - an unrecognised or ambiguous filename is never inline.

// D-144 (E5 Wave F0, "plays where it plays"): mov/m4v/mkv join the video containers a browser MAY
// plausibly play - amending security invariant 3 deliberately (recorded here, not slipped in). This is
// judged acceptable because these are video CONTAINERS, not markup: unlike .svg/.html they are not a
// script-execution vector, they are served from the dl. containment origin (no cookie, no SDK - D-33), and
// `nosniff` still applies. Playability itself is decided at RUNTIME per browser (canPlayType()/error, never
// sniffed) - see web/src/components/PreviewCard.tsx. Do NOT use this as precedent to add a markup format.
export const INLINE_ALLOWLIST = [
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mkv",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "pdf",
  "txt",
  // Live-testing addition (2026-08-06): ".md files do not render as a text field" - `languageFor()`
  // (textPreview.ts) already had a `md: "markdown"` Prism mapping sitting dead, reachable only via the
  // `<name>.md.txt` double-extension trick that same file's own comment documents. Served as literal
  // `text/plain` below, exactly like `.txt` - this is NOT markdown rendering (no HTML is ever generated
  // from it), so it carries none of security invariant 3's markup-execution risk; `nosniff` plus a
  // `text/plain` Content-Type means a browser displays the raw source, never interprets it.
  "md",
] as const;

// The final extension only, matching Node's own path.extname() convention: a purely leading-dot name
// (".txt") has NO extension by this rule (fail closed on the ambiguous case) - only text after a dot that
// follows a non-dot character counts.
function finalExtension(filename: string): string | null {
  const base = filename.replace(/^\.+/, "");
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return null;
  return base.slice(lastDot + 1).toLowerCase();
}

export function isInlineAllowed(filename: string): boolean {
  const ext = finalExtension(filename);
  return ext !== null && (INLINE_ALLOWLIST as readonly string[]).includes(ext);
}

export function contentDisposition(filename: string): "inline" | "attachment" {
  return isInlineAllowed(filename) ? "inline" : "attachment";
}

// D-74: the preview unfurl block needs a real MIME type (og:image:type, og:video:type, JSON-LD's
// encodingFormat). Kept next to INLINE_ALLOWLIST, covering exactly the same types, so the two cannot drift.
const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  // D-144: the matching real types for the widened INLINE_ALLOWLIST above - both halves are required in
  // the same change. An unmapped extension falls back to application/octet-stream, which `nosniff` then
  // blocks from rendering no matter what Content-Disposition says, silently defeating the widening above.
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  // Deliberately `text/plain`, never `text/markdown` - see the INLINE_ALLOWLIST entry above for why.
  md: "text/plain",
};

export function mimeTypeFor(filename: string): string {
  const ext = finalExtension(filename);
  return (ext !== null && MIME_TYPES[ext]) || "application/octet-stream";
}
