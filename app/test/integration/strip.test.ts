import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { stripInPlace } from "../../src/storage/strip.ts";

const execFileAsync = promisify(execFile);

// D-60/D-143: images via sharp, video containers via ffmpeg (stream-copy only), classified from the
// BYTES - never the filename (D-143). Against real sharp/ffmpeg (D-45's whole rationale - a native
// module's behavior is exactly the class of thing that must be exercised, not assumed).
describe("stripInPlace() (D-60/D-143)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "strip-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("strips GPS EXIF from a JPEG and is idempotent on the second call", async () => {
    const jpegPath = path.join(dir, "photo.jpg");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .jpeg()
      .withExif({
        // sharp's Exif type only names IFD0-IFD3; GPS tags conventionally live in IFD3. The tag values
        // don't need to be spec-valid GPS coordinates - this only needs to make sharp emit a real EXIF
        // APP1 segment so metadata().exif is populated, which is all stripInPlace()'s inspection checks.
        IFD3: { GPSLatitude: "51/1 30/1 0/1", GPSLatitudeRef: "N" },
      })
      .toFile(jpegPath);

    const before = await sharp(jpegPath).metadata();
    expect(before.exif).toBeDefined();

    const firstResult = await stripInPlace(jpegPath);
    expect(firstResult).toBe(true);

    const after = await sharp(jpegPath).metadata();
    expect(after.exif).toBeUndefined();

    // Idempotent by inspection (D-60): the second call finds nothing to strip and does not rewrite.
    const secondResult = await stripInPlace(jpegPath);
    expect(secondResult).toBe(false);
  });

  // D-143's core claim: the extension is never consulted, so it cannot lie its way out of stripping. A
  // GPS-bearing JPEG named "photo.txt" - or with no extension at all - is exactly the case the OLD
  // extension-allowlist design silently skipped (stripStrategyFor("photo.txt") === "none").
  it("strips a GPS-bearing JPEG named 'photo.txt' - the extension never decides (D-143)", async () => {
    const lyingPath = path.join(dir, "photo.txt");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitude: "1/1 0/1 0/1", GPSLatitudeRef: "N" } })
      .toFile(lyingPath);

    expect((await sharp(lyingPath).metadata()).exif).toBeDefined();
    const result = await stripInPlace(lyingPath);
    expect(result).toBe(true);
    expect((await sharp(lyingPath).metadata()).exif).toBeUndefined();
  });

  it("strips a GPS-bearing JPEG with NO extension at all (D-143)", async () => {
    const noExtPath = path.join(dir, "photo-no-extension");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 4, g: 5, b: 6 } } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitude: "2/1 0/1 0/1", GPSLatitudeRef: "N" } })
      .toFile(noExtPath);

    expect((await sharp(noExtPath).metadata()).exif).toBeDefined();
    const result = await stripInPlace(noExtPath);
    expect(result).toBe(true);
    expect((await sharp(noExtPath).metadata()).exif).toBeUndefined();
  });

  it("removes container-level metadata from an mp4 via stream copy, without re-encoding (D-20)", async () => {
    const mp4Path = path.join(dir, "video.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
      "-metadata", "comment=secret-location-data",
      "-c:v", "libx264", "-b:v", "500k", "-pix_fmt", "yuv420p", mp4Path,
    ]);

    const probeBefore = await ffprobe(mp4Path);
    expect(probeBefore.format.tags.comment).toBe("secret-location-data");

    const result = await stripInPlace(mp4Path);
    expect(result).toBe(true);

    const probeAfter = await ffprobe(mp4Path);
    expect(probeAfter.format.tags.comment).toBeUndefined();
    // Benign container tags (never user metadata) survive - stripping is about the "comment" field, not
    // gutting the container.
    expect(probeAfter.format.tags.major_brand).toBe(probeBefore.format.tags.major_brand);

    // Stream copy, not a transcode: codec and bitrate are unchanged (D-20 - the box is too weak to
    // transcode; -c copy is a remux).
    expect(probeAfter.streams[0].codec_name).toBe(probeBefore.streams[0].codec_name);
    expect(probeAfter.streams[0].bit_rate).toBe(probeBefore.streams[0].bit_rate);
  });

  it("strips metadata from a .mov carrying GPS (D-143) - undetected by the old extension allowlist", async () => {
    const movPath = path.join(dir, "iphone-clip.mov");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
      "-metadata", "location=+51.5074-000.1278/", // the GPS ISO 6709 tag an iPhone writes
      "-c:v", "libx264", "-b:v", "500k", "-pix_fmt", "yuv420p", "-f", "mov", movPath,
    ]);

    const probeBefore = await ffprobe(movPath);
    expect(probeBefore.format.tags.location).toBeDefined();

    const result = await stripInPlace(movPath);
    expect(result).toBe(true);

    const probeAfter = await ffprobe(movPath);
    expect(probeAfter.format.tags.location).toBeUndefined();
    expect(probeAfter.streams[0].codec_name).toBe(probeBefore.streams[0].codec_name);
  });

  it("strips metadata from a .mkv carrying GPS (D-143) - undetected by the old extension allowlist", async () => {
    const mkvPath = path.join(dir, "clip.mkv");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
      "-metadata", "comment=secret-gps-location",
      "-c:v", "libx264", "-b:v", "500k", "-pix_fmt", "yuv420p", "-f", "matroska", mkvPath,
    ]);

    // Matroska surfaces simple tags UPPERCASE via ffprobe ("COMMENT", not "comment" as mp4 does) - verified
    // empirically. hasNonBenignTags() in strip.ts lowercases keys before comparing, so this casing
    // difference does not affect stripping itself, only this test's own assertion.
    const probeBefore = await ffprobe(mkvPath);
    expect(probeBefore.format.tags.COMMENT).toBe("secret-gps-location");

    const result = await stripInPlace(mkvPath);
    expect(result).toBe(true);

    const probeAfter = await ffprobe(mkvPath);
    expect(probeAfter.format.tags.COMMENT).toBeUndefined();
    expect(probeAfter.streams[0].codec_name).toBe(probeBefore.streams[0].codec_name);
  });

  it("leaves an animated GIF with no detectable metadata untouched (more than one frame survives)", async () => {
    // Empirical finding (session finding, not an assumption per D-55): this repo's pinned sharp/libvips
    // version does not read or write exif/icc/xmp for GIF at all, on either the read or write side -
    // verified directly against this container. hasImageMetadata() therefore always reports false for a
    // real-world GIF, so stripInPlace() never rewrites one today. This is still a real, valid regression
    // test: it protects the "already clean -> untouched" half of D-60's idempotence claim for the format.
    const gifPath = path.join(dir, "anim.gif");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1.5:size=20x20:rate=2", gifPath,
    ]);

    const before = await sharp(gifPath, { animated: true }).metadata();
    expect(before.pages).toBeGreaterThan(1);

    const result = await stripInPlace(gifPath);
    expect(result).toBe(false);

    const after = await sharp(gifPath, { animated: true }).metadata();
    expect(after.pages).toBe(before.pages);
  });

  it("validates the animated write recipe directly: {animated:true} + toFormat('gif') preserves every frame on an actual rewrite", async () => {
    // Companion to the test above. Because sharp cannot be driven to report GIF metadata (confirmed
    // empirically), stripInPlace()'s public, inspect-gated API can never be forced into its GIF rewrite
    // branch through a black-box fixture. This test instead validates the exact sharp recipe
        // storage/strip.ts's stripImage() uses (read with `{ animated: true }`, write via `.toFormat()`)
    // against the real risk D-60 calls out by name: omitting `animated: true` flattens a multi-frame
    // GIF/WebP to its first frame. If this ever regresses, an eventual GIF rewrite (once triggered, by
    // this sharp version or a future one that does detect GIF metadata) would silently lose every frame
    // but one.
    const gifPath = path.join(dir, "anim-for-recipe-check.gif");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1.5:size=20x20:rate=2", gifPath,
    ]);
    const before = await sharp(gifPath, { animated: true }).metadata();
    expect(before.pages).toBeGreaterThan(1);

    const rewritten = path.join(dir, "anim-rewritten.gif");
    await sharp(gifPath, { animated: true }).toFormat("gif").toFile(rewritten);

    const after = await sharp(rewritten, { animated: true }).metadata();
    expect(after.pages).toBe(before.pages);
  });

  it("strips a TIFF (D-143's named leak format) if this sharp build supports round-tripping it", async () => {
    // Named explicitly in D-143 alongside .heic/.avif as a format the old extension allowlist silently
    // skipped. tiff-dev is present in this build (Dockerfile/docker-compose.verify.yml), so this asserts
    // real behaviour rather than skipping - unlike heic/avif, whose encoder support in this minimal Alpine
    // libvips build is not guaranteed, this format's presence IS guaranteed here.
    //
    // Empirical finding (D-55 - checked, not assumed): this sharp/libvips build does NOT embed EXIF into a
    // TIFF via withExif() at all (metadata().exif comes back undefined after write, verified directly
    // against this container) - the same class of gap the GIF test above already documents for a
    // different format/tag combination. An embedded ICC profile DOES round-trip for TIFF in this build
    // (verified directly), and hasImageMetadata() treats icc/exif/iptc/xmp uniformly, so this exercises the
    // exact same code path stripInPlace() uses for any other image metadata kind.
    const tiffPath = path.join(dir, "scan.tiff");
    await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 9, g: 8, b: 7 } } })
      .tiff()
      .withMetadata({ icc: "srgb" })
      .toFile(tiffPath);

    expect((await sharp(tiffPath).metadata()).icc).toBeDefined();
    const result = await stripInPlace(tiffPath);
    expect(result).toBe(true);
    expect((await sharp(tiffPath).metadata()).icc).toBeUndefined();
  });

  it("on failure, cleans up the temp file, leaves the original untouched, and rejects", async () => {
    // A real container ffprobe correctly detects as VIDEO (it has a genuine video stream - classify()
    // must not reject this file as "unknown"), but whose probed format this module has no muxer mapping
    // for (A6.2's deliberately small, explicit map only covers mp4/mov-family/webm/matroska - the two
    // formats this epic actually cares about, D-143). This is a real, detectable-but-unstrippable file,
    // exactly the case A6.4 requires to fail closed - not a fabricated corrupt-bytes case, which (correctly,
    // under content-based classification) is no longer distinguishable from "not a photo or video at all".
    const aviPath = path.join(dir, "legacy.avi");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=32x32:rate=5",
      "-c:v", "mpeg4", "-f", "avi", aviPath,
    ]);
    const originalBytes = await readFile(aviPath);

    await expect(stripInPlace(aviPath)).rejects.toThrow();

    const stillThere = await readFile(aviPath);
    expect(stillThere).toEqual(originalBytes);

    const tempPath = path.join(dir, ".legacy.avi.stripping");
    await expect(stat(tempPath)).rejects.toThrow();
  });

  it("leaves an audio-only file untouched - out of scope, not a video (D-60's corrected scope)", async () => {
    // Found live (2026-08-06): a bare `hasMediaStream` check treated ANY audio stream as "video", and an
    // mp3's ID3 tags trip hasVideoMetadata() almost every time - so this file hit stripVideo(), found no
    // muxer for the "mp3" family (muxerForProbedFormat only knows mp4/mov and matroska/webm), and the
    // WHOLE UPLOAD was rejected with a 422, on a file this invariant was never scoped to cover.
    const mp3Path = path.join(dir, "song.mp3");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "title=secret-not-actually-a-gap", "-c:a", "libmp3lame", mp3Path,
    ]);
    const probeBefore = await ffprobe(mp3Path);
    expect(probeBefore.format.tags.title).toBe("secret-not-actually-a-gap"); // has metadata a video WOULD strip
    const originalBytes = await readFile(mp3Path);

    const result = await stripInPlace(mp3Path);
    expect(result).toBe(false); // out of scope, not "detected but unstrippable" - never rejects

    const after = await readFile(mp3Path);
    expect(after).toEqual(originalBytes);
  });

  it("returns false without touching disk for a non-media file (pdf, txt) - out of scope, not a gap (D-143)", async () => {
    const txtPath = path.join(dir, "notes.txt");
    await writeFile(txtPath, "hello");
    const before = await readFile(txtPath);

    const result = await stripInPlace(txtPath);
    expect(result).toBe(false);

    const after = await readFile(txtPath);
    expect(after).toEqual(before);
  });

  it("a genuinely non-media file uploads as-is even with a LYING image extension (D-143 - the extension never decides)", async () => {
    // Under the OLD extension-based design this file (garbage bytes named ".png") would have been
    // classified "image" by name alone and would fail hasImageMetadata()'s sharp.metadata() call. Under
    // content-based classification it is correctly "unknown" - not a detectable photo or video - which is
    // exactly the same bucket a .zip or .pdf falls into, regardless of what its extension claims.
    const lyingPath = path.join(dir, "not-really-a.png");
    await writeFile(lyingPath, Buffer.from("just some bytes, not an image"));
    const before = await readFile(lyingPath);

    const result = await stripInPlace(lyingPath);
    expect(result).toBe(false);

    const after = await readFile(lyingPath);
    expect(after).toEqual(before);
  });
});

interface FfprobeOutput {
  format: { tags: Record<string, string> };
  streams: { codec_name: string; bit_rate: string }[];
}

async function ffprobe(filePath: string): Promise<FfprobeOutput> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}
