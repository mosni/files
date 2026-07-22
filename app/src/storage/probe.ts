// D-74: media dimensions captured at ingest, so the preview's unfurl block can emit
// `og:image:width`/`height` and `og:video:width`/`height`/`duration` - Discord decides between a large
// media embed and a bare link partly on these. `strip.ts` already reads this information via sharp/
// ffprobe at upload and throws it away; this module is the second (and only other) place allowed to call
// into sharp/ffprobe, so both stay in `storage/`.
//
// Never throws: a probe failure must never fail an upload, since the file is already committed by then.

import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { stripStrategyFor } from "../lib/media.ts";

const execFileAsync = promisify(execFile);

export type MediaProbe = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  textPreview: string | null;
};

const EMPTY_PROBE: MediaProbe = {
  width: null,
  height: null,
  durationSeconds: null,
  textPreview: null,
};

// Mirrors mime.ts's/media.ts's private finalExtension() exactly - the final extension only, matching
// Node's own path.extname() convention.
function finalExtension(filename: string): string | null {
  const base = filename.replace(/^\.+/, "");
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return null;
  return base.slice(lastDot + 1).toLowerCase();
}

async function probeImage(absolutePath: string): Promise<MediaProbe> {
  // animated: true is mandatory on read (same reason as strip.ts): without it, sharp reports `height` as
  // every frame of an animated GIF/WebP stacked vertically. `pageHeight` is the true single-frame height;
  // fall back to `height` for a non-animated image, where pageHeight is undefined.
  const metadata = await sharp(absolutePath, { animated: true }).metadata();
  return {
    ...EMPTY_PROBE,
    width: metadata.width ?? null,
    height: metadata.pageHeight ?? metadata.height ?? null,
  };
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}
interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

async function probeVideo(absolutePath: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ]);
  const probe = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = (probe.streams ?? []).find((stream) => stream.codec_type === "video");
  const durationRaw = probe.format?.duration;
  const duration = durationRaw === undefined ? Number.NaN : Number(durationRaw);
  return {
    ...EMPTY_PROBE,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
  };
}

// Strips every control character except newline/tab, then collapses all whitespace (including those two)
// to a single space - a bounded read of an already-uploaded file at ingest, not on a request path, so it
// does not touch invariant 2.
function cleanTextPreview(raw: string): string | null {
  const cleaned = raw
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return cleaned.length > 0 ? cleaned : null;
}

async function probeText(absolutePath: string): Promise<MediaProbe> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { ...EMPTY_PROBE, textPreview: cleanTextPreview(text) };
  } finally {
    await handle.close();
  }
}

export async function probeMedia(absolutePath: string): Promise<MediaProbe> {
  try {
    const filename = path.basename(absolutePath);
    const strategy = stripStrategyFor(filename);
    if (strategy === "image") return await probeImage(absolutePath);
    if (strategy === "video") return await probeVideo(absolutePath);
    if (finalExtension(filename) === "txt") return await probeText(absolutePath);
    return { ...EMPTY_PROBE };
  } catch {
    // Corrupt file, sharp refusing the format, ffprobe absent, etc. - a probe failure must never fail an
    // upload; the file is already committed by the time this runs.
    return { ...EMPTY_PROBE };
  }
}
