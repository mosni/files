// D-137: thumbnail POLICY - which source types get one, and what its filename is. Pure and I/O-free
// (technical-baseline.md §2); actual generation (which needs sharp) lives in storage/thumbs.ts.

import { mediaKindByExtension } from "./media.ts";

export const THUMB_MAX_EDGE = 512;
export const THUMB_FORMAT = "webp";

// Images AND video (D-137, amended in this session). A single-keyframe grab is NOT the transcode D-20/D-78
// rule out: it decodes one already-keyframe-aligned frame (no arbitrary-timestamp seek, no scene
// detection - see storage/thumbs.ts), which is a few tens of milliseconds even on a weak Atom, versus
// O(every frame) for real transcoding. Reuses media.ts's extension-based guess: a thumbnail is a display
// nicety, not a security gate, so the same "what does the name suggest" logic that's wrong for stripping
// (D-143) is exactly right here.
export function thumbnailApplies(filename: string): boolean {
  return mediaKindByExtension(filename) !== "none";
}

// Deterministic and collision-free within a source's own "<YYYY>/<mm>/" directory: `fileId` is already
// unique there (it prefixes the source's own disk name, D-82), so suffixing it here can never collide with
// another file's thumbnail or with the source itself.
export function thumbNameFor(fileId: string): string {
  return `${fileId}-thumb.${THUMB_FORMAT}`;
}

// B2: og:image:width/height must describe the THUMBNAIL, not the source, when a thumbnail is used -
// emitting the source's real dimensions alongside a thumbnail URL is exactly the mismatch that makes
// Discord fall back to a bare link instead of a card. No thumbnail dimensions are stored (D-138: no new
// columns), so this recomputes them from the stored SOURCE dimensions using the exact same arithmetic
// sharp's `.resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true })` performs
// (verified empirically against real sharp output across several aspect ratios, including non-exact
// ratios, before relying on it here) - never enlarges, longest edge capped at THUMB_MAX_EDGE, aspect ratio
// preserved by rounding the constrained dimension.
export function thumbDimensionsFor(
  width: number | null,
  height: number | null,
): { width: number; height: number } | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  if (width <= THUMB_MAX_EDGE && height <= THUMB_MAX_EDGE) return { width, height };
  const scale = THUMB_MAX_EDGE / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
