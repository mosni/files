// Security invariant 3 (technical-baseline.md §1): anything not on this allowlist is served
// `Content-Disposition: attachment`. Fail closed - an unrecognised or ambiguous filename is never inline.

export const INLINE_ALLOWLIST = [
  "mp4",
  "webm",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "pdf",
  "txt",
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
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
};

export function mimeTypeFor(filename: string): string {
  const ext = finalExtension(filename);
  return (ext !== null && MIME_TYPES[ext]) || "application/octet-stream";
}
