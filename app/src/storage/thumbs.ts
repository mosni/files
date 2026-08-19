// D-137 (amended in this session): thumbnail GENERATION - the only I/O half of the thumbnail feature
// (policy/naming stays in lib/thumbs.ts, which must stay I/O-free per technical-baseline.md §2). Joins
// strip.ts and probe.ts as the fourth module allowed to call into sharp/ffmpeg.
//
// Video thumbnails (added in this session, reversing the original "images only" call): a single-keyframe
// grab is NOT the transcode D-20/D-78 rule out. `-ss` BEFORE `-i` seeks the DEMUXER to the nearest keyframe
// rather than decoding forward from frame 0 - genuinely cheap (one keyframe decode, tens of milliseconds
// even on a weak Atom), unlike an arbitrary-timestamp seek or scene detection, which would force decoding a
// whole GOP and is exactly the kind of cost D-20/D-78 exist to rule out. No scene detection, no "smart"
// frame picking, no directory-wide eagerness - one keyframe, once, at ingest.

import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { mediaKindByExtension } from "../lib/media.ts";
import { THUMB_MAX_EDGE, thumbNameFor } from "../lib/thumbs.ts";
import { runMediaTool } from "./mediaExec.ts";

async function extractVideoKeyframe(sourceAbsPath: string, tempFramePath: string): Promise<void> {
  // Bounded by storage/mediaExec.ts (review 060/SEC-2). An abort surfaces as an ordinary failure here -
  // generateThumb() already returns null on ANY error, and a missing thumbnail never fails an upload.
  await runMediaTool("ffmpeg", [
    "-y", "-ss", "0", "-i", sourceAbsPath, "-frames:v", "1", tempFramePath,
  ]);
}

async function writeThumbFromSource(sourceAbsPath: string, thumbPath: string): Promise<void> {
  // animated: false here is deliberate and is the OPPOSITE of strip.ts's `animated: true` - a thumbnail is
  // a still, so flattening an animated GIF to its first frame is correct for a thumbnail and would be a bug
  // for a strip (which must preserve every frame). Do not "fix" this into matching strip.ts.
  await sharp(sourceAbsPath, { animated: false })
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp()
    .toFile(thumbPath);
}

/**
 * Writes a WebP thumbnail (512px longest edge) next to `sourceAbsPath`, named via thumbNameFor(fileId).
 * Returns the thumbnail's bare filename on success, or null on ANY failure - same contract as probe.ts:
 * the source file is already committed by the time this runs, so a thumbnail failure must never fail the
 * upload it is decorating. Never throws. Runs synchronously in the ingest pass, same as an image thumbnail
 * - the worst case (a large 4K keyframe decode) is still on the order of a few hundred milliseconds, small
 * next to the upload itself.
 */
export async function generateThumb(sourceAbsPath: string, fileId: string): Promise<string | null> {
  const thumbName = thumbNameFor(fileId);
  const thumbPath = path.join(path.dirname(sourceAbsPath), thumbName);
  const kind = mediaKindByExtension(path.basename(sourceAbsPath));

  if (kind === "video") {
    const framePath = path.join(os.tmpdir(), `${fileId}-thumb-frame.png`);
    try {
      await extractVideoKeyframe(sourceAbsPath, framePath);
      await writeThumbFromSource(framePath, thumbPath);
      return thumbName;
    } catch (err) {
      console.error(`storage/thumbs: generateThumb (video) failed for ${sourceAbsPath} - continuing without one`, err);
      return null;
    } finally {
      await unlink(framePath).catch(() => {});
    }
  }

  try {
    await writeThumbFromSource(sourceAbsPath, thumbPath);
    return thumbName;
  } catch (err) {
    console.error(`storage/thumbs: generateThumb failed for ${sourceAbsPath} - continuing without one`, err);
    return null;
  }
}
