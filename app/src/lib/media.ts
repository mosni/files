// Extension-based media-kind GUESS. Used ONLY for display/routing purposes that are not security
// decisions: lib/previewContext.ts's previewKindFor() (which UI component to render) and
// storage/probe.ts's dimension-probe routing (D-74).
//
// ⚠ This is NOT authoritative for whether metadata stripping applies (D-143, corrected 2026-07-30).
// storage/strip.ts classifies from the file's BYTES (sharp/ffprobe), never from the filename, because an
// extension allowlist governing stripping fails OPEN: every unlisted or lying extension would silently
// skip stripping, and the list can never be complete. This module only ever answers "what does the name
// suggest", which is fine for a UI guess and wrong for a security gate.

export type MediaExtensionKind = "image" | "video" | "none";

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"] as const;
// D-144 (E5 Wave F0): mov/m4v/mkv join the display-only video guess, matching the widened INLINE_ALLOWLIST
// (mime.ts) - previewKindFor() (lib/previewContext.ts) reads this to pick the video player component, and
// thumbnailApplies() (lib/thumbs.ts) reads it to decide whether a keyframe-grab thumbnail applies; both are
// correct extensions for these containers to gain.
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v", "mkv"] as const;

// The final extension only, matching Node's own path.extname() convention: a purely leading-dot name
// (".txt") has NO extension by this rule (fail closed on the ambiguous case) - only text after a dot that
// follows a non-dot character counts. Mirrors mime.ts's private finalExtension() exactly.
function finalExtension(filename: string): string | null {
  const base = filename.replace(/^\.+/, "");
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return null;
  return base.slice(lastDot + 1).toLowerCase();
}

export function mediaKindByExtension(filename: string): MediaExtensionKind {
  const ext = finalExtension(filename);
  if (ext === null) return "none";
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  return "none";
}
