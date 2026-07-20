// D-60: uploaded images and videos get embedded metadata (EXIF/GPS etc.) stripped in place at
// ingest - images via sharp, video containers via ffmpeg (stream-copy only). This module only
// classifies a filename into the strategy that applies; it does no I/O and never touches
// sharp/ffmpeg itself (see storage/strip.ts for the actual stripping).

export type StripStrategy = "image" | "video" | "none";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"] as const;
const VIDEO_EXTENSIONS = ["mp4", "webm"] as const;

// The final extension only, matching Node's own path.extname() convention: a purely leading-dot name
// (".txt") has NO extension by this rule (fail closed on the ambiguous case) - only text after a dot that
// follows a non-dot character counts. Mirrors mime.ts's private finalExtension() exactly.
function finalExtension(filename: string): string | null {
  const base = filename.replace(/^\.+/, "");
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return null;
  return base.slice(lastDot + 1).toLowerCase();
}

export function stripStrategyFor(filename: string): StripStrategy {
  const ext = finalExtension(filename);
  if (ext === null) return "none";
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  // PDF (and everything else) is deliberately "none": neither sharp nor ffmpeg can touch PDF
  // metadata, so PDF stripping is a documented, known gap - not a bug to silently "fix" here.
  // Revisit the tradeoffs explicitly before ever extending this to cover PDFs.
  return "none";
}
