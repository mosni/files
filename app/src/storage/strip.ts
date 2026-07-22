// D-60: the ONLY module that rewrites bytes on disk. Strips metadata in place, inspecting first so it
// costs nothing on an already-clean file. That idempotence was originally motivated by reconciliation
// re-stripping the same file repeatedly; D-66 removed reconciliation, so stripping now happens exactly
// once per upload - the inspect-first behaviour is kept anyway, because it is what guarantees a file
// takes at most one generation loss no matter how often this is called.

import { execFile } from "node:child_process";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { stripStrategyFor } from "../lib/media.ts";

const execFileAsync = promisify(execFile);

const SHARP_FORMAT: Record<string, "jpeg" | "png" | "webp" | "gif"> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

// ffmpeg/ffprobe attach these to the container itself, even on an already-stripped file - they are not
// user metadata. Anything else present means the file still carries something to remove.
const BENIGN_VIDEO_TAGS = new Set([
  "encoder",
  "handler_name",
  "vendor_id",
  "major_brand",
  "minor_version",
  "compatible_brands",
  "language",
]);

function tempPathFor(absolutePath: string): string {
  return path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.stripping`);
}

async function hasImageMetadata(absolutePath: string): Promise<boolean> {
  const metadata = await sharp(absolutePath, { animated: true }).metadata();
  return (
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.iptc !== undefined ||
    metadata.xmp !== undefined
  );
}

async function stripImage(absolutePath: string, temp: string): Promise<void> {
  const ext = path.extname(absolutePath).slice(1).toLowerCase();
  const format = SHARP_FORMAT[ext];
  // animated: true is mandatory on read - without it an animated GIF/WebP is flattened to its first
  // frame. The explicit format call on write (rather than relying on temp's own extension) is what lets
  // the temp filename be `.<name>.stripping` regardless of the real extension.
  const pipeline = sharp(absolutePath, { animated: true });
  const withFormat =
    format === "jpeg" ? pipeline.jpeg() :
    format === "png" ? pipeline.png() :
    format === "webp" ? pipeline.webp() :
    format === "gif" ? pipeline.gif() :
    pipeline;
  await withFormat.toFile(temp);
}

type FfprobeTags = Record<string, unknown>;
interface FfprobeOutput {
  format?: { tags?: FfprobeTags };
  streams?: { tags?: FfprobeTags }[];
}

function hasNonBenignTags(tags: FfprobeTags | undefined): boolean {
  if (tags === undefined) return false;
  return Object.keys(tags).some((key) => !BENIGN_VIDEO_TAGS.has(key.toLowerCase()));
}

async function hasVideoMetadata(absolutePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ]);
  const probe = JSON.parse(stdout) as FfprobeOutput;
  if (hasNonBenignTags(probe.format?.tags)) return true;
  return (probe.streams ?? []).some((stream) => hasNonBenignTags(stream.tags));
}

const FFMPEG_CONTAINER: Record<string, string> = { mp4: "mp4", webm: "webm" };

async function stripVideo(absolutePath: string, temp: string): Promise<void> {
  const ext = path.extname(absolutePath).slice(1).toLowerCase();
  const container = FFMPEG_CONTAINER[ext];
  // -f <container> is mandatory: the temp filename is `.<name>.stripping`, which has no extension ffmpeg
  // can infer a muxer from, and without -f it fails outright with "Unable to choose an output format"
  // (confirmed empirically - this is not a hypothetical). Stream copy, never a transcode (D-20 - the box
  // is too weak): -map_metadata -1 drops all metadata, -c copy remuxes without touching the encoded
  // streams.
  await execFileAsync("ffmpeg", [
    "-y", "-i", absolutePath, "-map_metadata", "-1", "-c", "copy", "-f", container, temp,
  ]);
}

/**
 * Strips metadata in place IF any is present (D-60). Returns false when there was nothing to do -
 * either the strategy is "none" (pdf/txt/etc, a documented gap - see lib/media.ts) or the file was
 * already clean, so reconciling the same file repeatedly costs at most one generation loss ever.
 *
 * On ANY failure, the temp file is removed, the original is left untouched, and this rejects - the
 * caller must then treat the file as unservable rather than serve an unstripped original.
 */
export async function stripInPlace(absolutePath: string): Promise<boolean> {
  const strategy = stripStrategyFor(path.basename(absolutePath));
  if (strategy === "none") return false;

  const hasMetadata =
    strategy === "image" ? await hasImageMetadata(absolutePath) : await hasVideoMetadata(absolutePath);
  if (!hasMetadata) return false;

  const temp = tempPathFor(absolutePath);
  try {
    if (strategy === "image") {
      await stripImage(absolutePath, temp);
    } else {
      await stripVideo(absolutePath, temp);
    }
    // The rename is the commit point (same directory, same filesystem - atomic): a reader never sees a
    // half-written file.
    await rename(temp, absolutePath);
    return true;
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}
