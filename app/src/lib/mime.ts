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

// --- content-based text delivery (live-testing, 2026-08-06) --------------------------------------------
//
// Hannah: "this should not be determined by file ending but by whether it's human readable characters or
// random bytes instead, syntax highlighting should be derived by ending after." `isText` is decided at
// ingest from the file's BYTES (lib/textDetect.ts, stored by migration 007); these two functions are where
// that answer replaces the filename for the two decisions that actually matter on the wire.
//
// ⚠⚠ SECURITY INVARIANT 3, AMENDED DELIBERATELY - read before changing either function.
//
// The allowlist above stays exactly as it was, and `.html`/`.svg` stay off it. What is added is: a file
// whose BYTES are text is delivered inline **as `text/plain` and nothing else**. That is what makes this
// safe, and it is the whole argument:
//   - `text/plain` + the `nosniff` already set on delivery means a browser DISPLAYS the source and never
//     parses it as markup - so an uploaded `.html` or `.svg` detected as text renders as its own source
//     code, which is precisely the "render as a text field" behaviour being asked for;
//   - the bytes are served from the `dl.` containment origin, which carries no cookie and never loads the
//     auth SDK (D-33), so even a hypothetical execution would have nothing to reach;
//   - the extension can no longer WIDEN anything - it is consulted only to pick a Prism language for
//     highlighting (web/src/lib -> lib/textPreview.ts's languageFor), which touches no header.
//
// The one thing that must never happen here is an is-text file being given a renderable Content-Type.
// contentTypeForRecord() therefore checks `isText` FIRST and returns text/plain unconditionally - it does
// not consult MIME_TYPES at all on that branch. Do not "optimise" that into a lookup with a text/plain
// fallback: that would let a future MIME_TYPES entry for html/svg silently turn every such upload into a
// stored XSS. The mime.test.ts case named "never returns a renderable type for a text-detected file" is
// the guard on this paragraph.
export type DeliverableFile = { name: string; isText: boolean };

export function isInlineAllowedFor(record: DeliverableFile): boolean {
  return record.isText || isInlineAllowed(record.name);
}

export function contentDispositionFor(record: DeliverableFile): "inline" | "attachment" {
  return isInlineAllowedFor(record) ? "inline" : "attachment";
}

export function contentTypeForRecord(record: DeliverableFile): string {
  // FIRST, and unconditionally - see the warning above.
  if (record.isText) return "text/plain; charset=utf-8";
  return mimeTypeFor(record.name);
}
