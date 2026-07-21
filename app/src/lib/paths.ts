import path from "node:path";

// Security-critical: user-controlled names flow into filesystem paths (the app mirrors URLs onto disk).
// This module is the boundary that keeps that safe. It REJECTS unsafe input (returns null) rather than
// sanitising it - trimming or rewriting a hostile name would make two distinct names collide.

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

/** Returns a safe single path segment (one level, no slashes), or null if it cannot be made safe. */
export function safeSegment(name: string): string | null {
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

  return name;
}

/**
 * Validates a URL-supplied relative path (preliminary-review P6: URLs mirror the on-disk tree, arbitrary
 * depth). Every `/`-separated segment must pass safeSegment - so `..`, control characters, empty segments
 * (a `//` or a leading/trailing slash), and per-segment traversal are all rejected. Returns the safe
 * relative path (the DB key and disk suffix), or null. Leading/trailing slashes are rejected rather than
 * trimmed, for the same "two inputs must not collapse to one" reason safeSegment rejects rather than trims.
 */
export function safeRelPath(relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  const segments = relPath.split("/");
  const safe: string[] = [];
  for (const segment of segments) {
    const s = safeSegment(segment);
    if (s === null) return null;
    safe.push(s);
  }
  return safe.join("/");
}

// Belt and braces: safeSegment/safeRelPath should already make escape impossible, but this is the
// security boundary for attacker-controlled path segments, so it verifies containment after path.resolve
// rather than trusting the segment checks alone.
function resolveWithinRoot(root: string, segments: readonly string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);

  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) return null;

  return resolved;
}

/** Joins STORAGE_ROOT + a (validated) relative path into an absolute path, or null if the path is unsafe. */
export function resolveRelPath(root: string, relPath: string): string | null {
  const safe = safeRelPath(relPath);
  if (safe === null) return null;
  return resolveWithinRoot(root, safe.split("/"));
}

// Duplicate display names are suffixed within a directory (`image.png` -> `image(2).png`), not made opaque.
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
