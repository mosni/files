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
import { mediaKindByExtension } from "../lib/media.ts";
import { looksLikeText, TEXT_DETECT_SAMPLE_BYTES } from "../lib/textDetect.ts";

const execFileAsync = promisify(execFile);

export type MediaProbe = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  textPreview: string | null;
  // Live-testing addition (2026-08-06): decided from the BYTES by lib/textDetect.ts, never the filename.
  isText: boolean;
};

const EMPTY_PROBE: MediaProbe = {
  width: null,
  height: null,
  durationSeconds: null,
  textPreview: null,
  isText: false,
};

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

// Live-testing rewrite (2026-08-06, Hannah): whether a file is text is decided by its BYTES, not its
// extension. Reads one bounded sample and answers both questions from it - is this text at all, and what
// is its snippet - so there is exactly one read and one source of truth.
async function probeText(absolutePath: string): Promise<MediaProbe> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_DETECT_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (!looksLikeText(sample)) return { ...EMPTY_PROBE };
    return { ...EMPTY_PROBE, isText: true, textPreview: cleanTextPreview(sample.toString("utf8")) };
  } finally {
    await handle.close();
  }
}

export async function probeMedia(absolutePath: string): Promise<MediaProbe> {
  const filename = path.basename(absolutePath);
  const kind = mediaKindByExtension(filename);

  // Image/video stay extension-routed: these are the probes that extract dimensions, and running sharp or
  // ffprobe over every upload on this box (an Atom N2800, D-78) to find out whether it might be an image
  // is exactly the cost D-20 rules out. A LYING extension is handled by falling through below rather than
  // by giving up - the old version returned an all-null probe for a text file named ".mp4".
  if (kind === "image" || kind === "video") {
    try {
      return kind === "image" ? await probeImage(absolutePath) : await probeVideo(absolutePath);
    } catch {
      // Not actually the media its name claims (or a corrupt one) - fall through to text detection rather
      // than giving up, so a text file with a misleading extension still previews correctly.
    }
  }

  try {
    return await probeText(absolutePath);
  } catch {
    // Unreadable file, etc. - a probe failure must never fail an upload; the file is already committed by
    // the time this runs.
    return { ...EMPTY_PROBE };
  }
}
