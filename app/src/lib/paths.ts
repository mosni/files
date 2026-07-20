import path from "node:path";

// D-58: collection names share a flat namespace with the app's own routes, so these first-segment
// names can never be claimed by a collection.
export const RESERVED_COLLECTION_NAMES = ["f", "api", "health", "assets", "favicon.ico"] as const;

const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const ONLY_DOTS_OR_WHITESPACE = /^[.\s]+$/;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

// Same "final extension only" convention as mime.ts's finalExtension(): leading dots don't count as
// the start of an extension, so ".gitignore" has no extension and "archive.tar.gz" splits on the
// last dot. Shared by safeSegment() (to find the part right before the extension) and
// suffixForCollision() (to insert the "(n)" before the extension rather than at the very end).
function splitExtension(name: string): { base: string; ext: string } {
  let leadingDots = 0;
  while (leadingDots < name.length && name[leadingDots] === ".") leadingDots++;
  const rest = name.slice(leadingDots);
  const lastDot = rest.lastIndexOf(".");
  if (lastDot < 0) return { base: name, ext: "" };
  const splitAt = leadingDots + lastDot;
  return { base: name.slice(0, splitAt), ext: name.slice(splitAt) };
}

// `kind` rather than a bare boolean: RESERVED_COLLECTION_NAMES only applies to the first path segment
// (the collection), never to a file's display name, and a caller reading `safeSegment(x, "collection")`
// doesn't need to remember what `true` meant here. Reserved-name checking stays inside this module
// (where the list already lives) instead of becoming every caller's job.
export function safeSegment(name: string, kind: "file" | "collection" = "file"): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  if (name === "." || name === "..") return null;
  if (ONLY_DOTS_OR_WHITESPACE.test(name)) return null;
  if (hasPathSeparator(name) || name.includes("\0")) return null;
  if (CONTROL_CHAR.test(name)) return null;
  if (name.trim() !== name) return null;

  // A trailing space right before the extension ("foo .png") isn't leading/trailing whitespace on the
  // whole string, but it's the same hazard: something upstream (a UI text field, another OS) trims it
  // silently, so the name the app thinks it wrote and the bytes actually on disk diverge.
  const { base } = splitExtension(name);
  if (base.trim() !== base) return null;

  if (Buffer.byteLength(name, "utf8") > 255) return null;

  // Defense in depth against double-decoding: if some other layer (a proxy, a browser, a future
  // caller) percent-decodes this value again, a still-encoded separator here would turn into a real
  // one there. Reject if decoding reveals what raw slash/backslash/control-char checks are for.
  // Malformed percent sequences (e.g. a literal "%" in "100%.png") throw and are treated as unencoded.
  try {
    const decoded = decodeURIComponent(name);
    if (decoded !== name && (hasPathSeparator(decoded) || CONTROL_CHAR.test(decoded))) return null;
  } catch {
    // Not a valid percent-encoding - nothing further to check.
  }

  if (kind === "collection" && (RESERVED_COLLECTION_NAMES as readonly string[]).includes(name)) {
    return null;
  }

  return name;
}

// Belt and braces (D-56): safeSegment() should already make escape impossible, but this is the
// security boundary for attacker-controlled path segments, so it doesn't rely on that alone.
function resolveWithinRoot(root: string, segments: readonly string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);

  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) return null;

  return resolved;
}

export function resolveStoragePath(root: string, collection: string, file: string): string | null {
  const safeCollection = safeSegment(collection, "collection");
  const safeFile = safeSegment(file, "file");
  if (safeCollection === null || safeFile === null) return null;

  return resolveWithinRoot(root, [safeCollection, safeFile]);
}

// Directory-only resolve, needed by storage/collections.ts to stat a collection's directory on disk
// before deciding whether to auto-create its row (D-57's "first touch").
export function resolveCollectionPath(root: string, collection: string): string | null {
  const safeCollection = safeSegment(collection, "collection");
  if (safeCollection === null) return null;

  return resolveWithinRoot(root, [safeCollection]);
}

// D-14's surviving half: duplicate display names are suffixed within a collection, not made opaque.
export function suffixForCollision(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;

  const { base, ext } = splitExtension(name);
  let n = 2;
  let candidate = `${base}(${n})${ext}`;
  while (taken.includes(candidate)) {
    n++;
    candidate = `${base}(${n})${ext}`;
  }
  return candidate;
}

export function isIgnoredEntry(name: string): boolean {
  return name.startsWith(".");
}
