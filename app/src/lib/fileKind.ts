// Live-testing addition (2026-08-06, Hannah): "for files that we preview, let's show a different lucide
// icon in the file browser list - for example, an audio file without cover art gets a music note symbol,
// a code text file gets code-text icon, etc."
//
// Pure and I/O-free (technical-baseline.md §2). This is a DISPLAY classification only - it decides which
// icon a row shows and nothing else. It is never a security gate, so unlike storage/strip.ts (D-143) it is
// allowed to consult the filename: getting an icon wrong costs a slightly wrong picture, which is the same
// bar lib/media.ts's mediaKindByExtension already sets for its own display-only guess.
//
// The one input that is NOT a filename guess is `isText`, which comes from the file's actual bytes
// (lib/textDetect.ts) - so a code file with no extension still reads as text, and a `.py` full of random
// bytes does not.

import { mediaKindByExtension } from "./media.ts";
import { languageFor } from "./textPreview.ts";

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "code"
  | "text"
  | "archive"
  | "other";

// Audio is classified here and ONLY here. storage/strip.ts deliberately treats audio as out of scope for
// metadata stripping (D-60's corrected scope: photos and videos), so there is no content-derived audio
// signal to reuse - and for an icon there does not need to be.
const AUDIO_EXTENSIONS = new Set([
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "wma", "aiff", "aif", "alac", "mid", "midi",
]);

const ARCHIVE_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso",
]);

function finalExtension(filename: string): string | null {
  const base = filename.replace(/^\.+/, "");
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return null;
  return base.slice(lastDot + 1).toLowerCase();
}

/**
 * The display kind for a file, used to pick its icon in the browser listing.
 *
 * Order is deliberate: real media first (an image is an image whatever else it might look like), then
 * audio, then the CONTENT-derived text answer, then the remaining extension buckets. Text is split into
 * `code` and `text` by whether the extension maps to a Prism language - which is exactly Hannah's
 * "syntax highlighting should be derived by ending after" rule reused for the icon.
 */
export function fileKindFor(filename: string, isText: boolean): FileKind {
  const media = mediaKindByExtension(filename);
  if (media === "image") return "image";
  if (media === "video") return "video";

  const ext = finalExtension(filename);
  if (ext !== null && AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";

  if (isText) return languageFor(filename) !== null ? "code" : "text";

  if (ext !== null && ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  return "other";
}
