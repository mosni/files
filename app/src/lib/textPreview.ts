// D-141 (E5 Wave E): full text/code preview policy - pure and I/O-free (technical-baseline.md §2). The
// actual fetch and CodeBlock rendering live in web/src/components/PreviewCard.tsx.

// Above this size, fetching the whole file and running it through Prism risks locking the tab - that is
// the actual reason for the cap, not a bandwidth concern. A file above it keeps the existing 400-char
// ingest snippet (probe.ts's textPreview) plus a download action instead.
export const TEXT_FULL_MAX_BYTES = 256 * 1024;

// Mirrors mime.ts's/media.ts's private finalExtension() exactly - the final extension only, matching
// Node's own path.extname() convention: a purely leading-dot name has NO extension by this rule.
function finalExtension(filename: string): string | null {
  const base = filename.replace(/^\.+/, "");
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return null;
  return base.slice(lastDot + 1).toLowerCase();
}

// mosni-code's Prism language identifiers, keyed by extension. Deliberately small: only common source/
// config extensions, not an exhaustive Prism language list.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
};

// Only `.txt` ever reaches PreviewCard's `kind === "text"` branch (mime.ts's INLINE_ALLOWLIST has no other
// text extension, and Wave E does not widen it - unlike Wave F0's deliberate video-container widening).
// So a code file shared through this app is named `<name>.<real-extension>.txt` (renamed to clear the
// inline allowlist while keeping the original extension visible) - the INNER extension is what carries
// language information; "txt" itself never does. A plain "notes.txt" has no inner extension and correctly
// returns null - Prism renders it unhighlighted, which IS correct for actual plain text.
export function languageFor(filename: string): string | null {
  const ext = finalExtension(filename);
  if (ext === null) return null;
  if (ext === "txt") {
    const withoutTxt = filename.slice(0, filename.length - ".txt".length);
    const inner = finalExtension(withoutTxt);
    return inner !== null ? (LANGUAGE_BY_EXTENSION[inner] ?? null) : null;
  }
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}
