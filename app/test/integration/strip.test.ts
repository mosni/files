import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { stripInPlace } from "../../src/storage/strip.ts";

const execFileAsync = promisify(execFile);

// D-60: images via sharp, video containers via ffmpeg (stream-copy only). Against real sharp/ffmpeg
// (D-45's whole rationale - a native module's behavior is exactly the class of thing that must be
// exercised, not assumed).
describe("stripInPlace() (D-60)", () => {
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

  it("validates the animated write recipe directly: {animated:true} + .gif() preserves every frame on an actual rewrite", async () => {
    // Companion to the test above. Because sharp cannot be driven to report GIF metadata (confirmed
    // empirically), stripInPlace()'s public, inspect-gated API can never be forced into its GIF rewrite
    // branch through a black-box fixture. This test instead validates the exact sharp recipe
    // storage/strip.ts's stripImage() uses (read with `{ animated: true }`, write via `.gif()`) against
    // the real risk D-60 calls out by name: omitting `animated: true` flattens a multi-frame GIF/WebP to
    // its first frame. If this ever regresses, an eventual GIF rewrite (once triggered, by this sharp
    // version or a future one that does detect GIF metadata) would silently lose every frame but one.
    const gifPath = path.join(dir, "anim-for-recipe-check.gif");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1.5:size=20x20:rate=2", gifPath,
    ]);
    const before = await sharp(gifPath, { animated: true }).metadata();
    expect(before.pages).toBeGreaterThan(1);

    const rewritten = path.join(dir, "anim-rewritten.gif");
    await sharp(gifPath, { animated: true }).gif().toFile(rewritten);

    const after = await sharp(rewritten, { animated: true }).metadata();
    expect(after.pages).toBe(before.pages);
  });

  it("on failure, cleans up the temp file, leaves the original untouched, and rejects", async () => {
    const corruptPath = path.join(dir, "corrupt.jpg");
    await writeFile(corruptPath, Buffer.from("not a real jpeg"));
    const originalBytes = await readFile(corruptPath);

    await expect(stripInPlace(corruptPath)).rejects.toThrow();

    const stillThere = await readFile(corruptPath);
    expect(stillThere).toEqual(originalBytes);

    const tempPath = path.join(dir, ".corrupt.jpg.stripping");
    await expect(stat(tempPath)).rejects.toThrow();
  });

  it("returns false without touching disk for a strategy of 'none' (e.g. pdf, txt)", async () => {
    const txtPath = path.join(dir, "notes.txt");
    await writeFile(txtPath, "hello");
    const before = await readFile(txtPath);

    const result = await stripInPlace(txtPath);
    expect(result).toBe(false);

    const after = await readFile(txtPath);
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
