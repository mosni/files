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
