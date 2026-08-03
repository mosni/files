// D-60: the ONLY module that rewrites bytes on disk. Strips metadata in place, inspecting first so it
// costs nothing on an already-clean file. That idempotence was originally motivated by reconciliation
// re-stripping the same file repeatedly; D-66 removed reconciliation, so stripping now happens exactly
// once per upload - the inspect-first behaviour is kept anyway, because it is what guarantees a file
// takes at most one generation loss no matter how often this is called.
//
// D-143 (2026-07-30): classification is CONTENT-based, never filename-based. The previous design read
// lib/media.ts's extension allowlist and returned "none" (no strip at all) for anything unlisted, which
// meant `.mov`, `.mkv`, `.heic` and every other unlisted format uploaded with their metadata - including
// GPS an iPhone writes into a `.mov` - fully intact since E2. An allowlist governing STRIPPING fails open:
// every unlisted or lying extension is a silent leak, and the list can never be complete. So this module
// now asks sharp/ffprobe what the BYTES actually are, and the filename never decides.

import { execFile } from "node:child_process";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

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

type FfprobeTags = Record<string, unknown>;
interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  tags?: FfprobeTags;
}
interface FfprobeOutput {
  format?: { tags?: FfprobeTags; format_name?: string };
  streams?: FfprobeStream[];
}

async function runFfprobe(absolutePath: string): Promise<FfprobeOutput> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}

// D-143/A6.1: classify from the BYTES, never the name. Try sharp first - it succeeds for any image format
// it supports, whatever the file is called. If that fails, try ffprobe and accept the file as "video" only
// if it reports at least one video OR audio stream (ffprobe will happily "identify" some non-media files
// with no such stream, e.g. some plain-text or binary formats, so a bare non-error is not enough evidence).
// Anything neither tool can positively identify is "unknown" - out of scope for this invariant (A6.3):
// non-media formats (pdf, docx, zip, txt...) are not a gap, and this is deliberately NOT a place to "try
// harder" - an undecodable file is, by definition, not a detectable photo or video.
type Classification =
  | { kind: "image"; metadata: sharp.Metadata }
  | { kind: "video"; probe: FfprobeOutput }
  | { kind: "unknown" };

async function classify(absolutePath: string): Promise<Classification> {
  try {
    const metadata = await sharp(absolutePath, { animated: true }).metadata();
    return { kind: "image", metadata };
  } catch {
    // Not an image sharp can decode - fall through to ffprobe. This also catches a merely-corrupt image:
    // an undecodable file is not a "detectable photo", so it is correctly out of scope, not a failure.
  }
  try {
    const probe = await runFfprobe(absolutePath);
    const hasMediaStream = (probe.streams ?? []).some(
      (stream) => stream.codec_type === "video" || stream.codec_type === "audio",
    );
    if (hasMediaStream) return { kind: "video", probe };
  } catch {
    // Not a container ffprobe can identify at all.
  }
  return { kind: "unknown" };
}

function hasImageMetadata(metadata: sharp.Metadata): boolean {
  return (
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.iptc !== undefined ||
    metadata.xmp !== undefined
  );
}

function hasNonBenignTags(tags: FfprobeTags | undefined): boolean {
  if (tags === undefined) return false;
  return Object.keys(tags).some((key) => !BENIGN_VIDEO_TAGS.has(key.toLowerCase()));
}

function hasVideoMetadata(probe: FfprobeOutput): boolean {
  if (hasNonBenignTags(probe.format?.tags)) return true;
  return (probe.streams ?? []).some((stream) => hasNonBenignTags(stream.tags));
}

async function stripImage(absolutePath: string, temp: string, detectedFormat: string): Promise<void> {
  // animated: true is mandatory on read - without it an animated GIF/WebP is flattened to its first frame.
  // Writing out via `.toFormat(detectedFormat)` - sharp's OWN detected format, never the filename's
  // extension - is the crux of D-143: a GPS-bearing JPEG uploaded as "photo.txt" (or with no extension at
  // all) must still round-trip as a JPEG, not fail or silently re-encode as something else. This also
  // generalises to any format sharp can both decode and encode, rather than a hardcoded four-format map -
  // a format sharp can decode but not encode in this build (e.g. some HEIF builds) throws here, which is
  // exactly the fail-closed path A6.4 requires: a detectable photo that cannot be stripped is never stored.
  await sharp(absolutePath, { animated: true })
    .toFormat(detectedFormat as keyof sharp.FormatEnum)
    .toFile(temp);
}

// WebM's spec is strict about what it may contain - VP8/VP9/AV1 video, Vorbis/Opus/WebVTT audio - unlike
// Matroska (webm's superset container), which accepts any codec. Used to disambiguate the ambiguous
// "matroska,webm" family below by what the streams actually ARE, not by name.
const WEBM_VIDEO_CODECS = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODECS = new Set(["vorbis", "opus"]);

// A6.2: ffprobe's `format_name` is often an ambiguous, comma-separated list rather than one name - every
// ISO-BMFF file (mp4, mov, m4v, 3gp, 3g2, mj2) reports the exact same family "mov,mp4,m4a,3gp,3g2,mj2"
// regardless of which of those it actually is, and EVERY Matroska-family file (mkv or webm) reports the
// exact same "matroska,webm" regardless of which of THOSE it actually is (verified empirically - a real
// H.264 .mkv and a real VP8 .webm both report identically). Passing that raw string to ffmpeg's `-f` is
// invalid, so a single muxer must be chosen deterministically per family - never derived from the original
// extension, which is exactly the thing this module no longer trusts.
function muxerForProbedFormat(probe: FfprobeOutput): string | null {
  const formatName = probe.format?.format_name;
  if (formatName === undefined) return null;
  const families = formatName.split(",");

  if (families.includes("matroska") || families.includes("webm")) {
    // format_name cannot tell mkv from webm apart - only the actual stream codecs can. WebM strictly
    // requires VP8/VP9/AV1 (+ Vorbis/Opus); anything else (e.g. this epic's own H.264 .mkv fixtures) can
    // only remux into Matroska, webm's superset container. A stream that plain doesn't exist (no audio
    // track) does not disqualify webm on its own.
    const video = (probe.streams ?? []).find((stream) => stream.codec_type === "video");
    const audio = (probe.streams ?? []).find((stream) => stream.codec_type === "audio");
    const videoFitsWebm = video?.codec_name === undefined || WEBM_VIDEO_CODECS.has(video.codec_name);
    const audioFitsWebm = audio?.codec_name === undefined || WEBM_AUDIO_CODECS.has(audio.codec_name);
    return videoFitsWebm && audioFitsWebm ? "webm" : "matroska";
  }
  // ffprobe reports the exact SAME ambiguous family "mov,mp4,m4a,3gp,3g2,mj2" for every ISO-BMFF file
  // regardless of whether the original was .mp4, .mov, .m4v, .3gp etc - format_name alone can never
  // disambiguate them either (the trap A6.2 names by name). "mp4" is the deterministic choice for the
  // WHOLE family: it is what an actual .mp4 needs to keep its major_brand unchanged on the stream copy
  // (the common case), and a genuine .mov/.m4v source still remuxes into a valid, playable ISO-BMFF
  // container even though its brand tag changes - never derived from the extension either way.
  if (families.includes("mp4") || families.includes("mov")) return "mp4";
  return null;
}

async function stripVideo(absolutePath: string, temp: string, probe: FfprobeOutput): Promise<void> {
  const muxer = muxerForProbedFormat(probe);
  if (muxer === null) {
    throw new Error(
      `storage/strip: no known muxer for probed format "${probe.format?.format_name ?? "unknown"}"`,
    );
  }
  // -f <container> is mandatory: the temp filename is `.<name>.stripping`, which has no extension ffmpeg
  // can infer a muxer from, and without -f it fails outright with "Unable to choose an output format"
  // (confirmed empirically - this is not a hypothetical). Stream copy, never a transcode (D-20 - the box
  // is too weak): -map_metadata -1 drops all metadata, -c copy remuxes without touching the encoded
  // streams.
  await execFileAsync("ffmpeg", [
    "-y", "-i", absolutePath, "-map_metadata", "-1", "-c", "copy", "-f", muxer, temp,
  ]);
}

/**
 * Strips metadata in place IF any is present (D-60), classifying the file from its BYTES, never its name
 * (D-143). Returns false when there was nothing to do - either the file is not a detectable photo or video
 * (out of scope for this invariant - A6.3) or it was already clean, so reconciling the same file repeatedly
 * costs at most one generation loss ever.
 *
 * On ANY failure to strip a file that WAS detected as a photo or video, the temp file is removed, the
 * original is left untouched, and this rejects - the caller must then treat the file as unservable rather
 * than serve an unstripped original (A6.4: this failure path already exists in controllers/upload.ts and is
 * unchanged by this classification fix).
 */
export async function stripInPlace(absolutePath: string): Promise<boolean> {
  const classification = await classify(absolutePath);
  if (classification.kind === "unknown") return false;

  const hasMetadata =
    classification.kind === "image"
      ? hasImageMetadata(classification.metadata)
      : hasVideoMetadata(classification.probe);
  if (!hasMetadata) return false;

  const temp = tempPathFor(absolutePath);
  try {
    if (classification.kind === "image") {
      const format = classification.metadata.format;
      if (format === undefined) throw new Error("storage/strip: sharp detected an image with no format");
      await stripImage(absolutePath, temp, format);
    } else {
      await stripVideo(absolutePath, temp, classification.probe);
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
