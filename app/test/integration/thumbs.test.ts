import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { generateThumb } from "../../src/storage/thumbs.ts";
import { THUMB_MAX_EDGE, thumbNameFor } from "../../src/lib/thumbs.ts";

const execFileAsync = promisify(execFile);

// D-137 (amended in this session to cover video too): thumbnails are generated at ingest, gated identically
// to their source. Against real sharp/ffmpeg (D-45's rationale - a native module's behaviour is exactly
// the class of thing that must be exercised).
describe("generateThumb() (D-137)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "thumbs-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces a WebP thumbnail <= 512px on its longest edge, in the source's own directory", async () => {
    const sourcePath = path.join(dir, "big.png");
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toFile(sourcePath);

    const fileId = "thumbTestId00001";
    const result = await generateThumb(sourcePath, fileId);
    expect(result).toBe(thumbNameFor(fileId));

    const thumbPath = path.join(dir, result!);
    const metadata = await sharp(thumbPath).metadata();
    expect(metadata.format).toBe("webp");
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(THUMB_MAX_EDGE);
    // 2000x1000 -> capped at 512 longest edge, aspect ratio preserved (2:1).
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(256);
  });

  it("never enlarges a source smaller than THUMB_MAX_EDGE", async () => {
    const sourcePath = path.join(dir, "small.png");
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 4, g: 5, b: 6 } } })
      .png()
      .toFile(sourcePath);

    const result = await generateThumb(sourcePath, "thumbTestId00002");
    const metadata = await sharp(path.join(dir, result!)).metadata();
    expect(metadata.width).toBe(40);
    expect(metadata.height).toBe(30);
  });

  it("flattens an animated source to a single still frame (animated: false, the OPPOSITE of strip.ts)", async () => {
    const gifPath = path.join(dir, "anim.gif");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1.5:size=40x40:rate=2", gifPath,
    ]);
    const before = await sharp(gifPath, { animated: true }).metadata();
    expect(before.pages).toBeGreaterThan(1);

    const result = await generateThumb(gifPath, "thumbTestId00003");
    const after = await sharp(path.join(dir, result!), { animated: true }).metadata();
    expect(after.pages ?? 1).toBe(1);
  });

  it("returns null for a non-image and never throws", async () => {
    const txtPath = path.join(dir, "notes.txt");
    await writeFile(txtPath, "hello");
    await expect(generateThumb(txtPath, "thumbTestId00004")).resolves.toBeNull();
  });

  it("returns null for a corrupt file claiming an image extension and never throws", async () => {
    const corruptPath = path.join(dir, "corrupt.png");
    await writeFile(corruptPath, Buffer.from("not a real png"));
    await expect(generateThumb(corruptPath, "thumbTestId00005")).resolves.toBeNull();
  });

  it("produces a WebP thumbnail from an mp4's first keyframe - a keyframe grab, not a transcode (D-20/D-78)", async () => {
    const mp4Path = path.join(dir, "clip.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5",
      "-c:v", "libx264", "-b:v", "500k", "-pix_fmt", "yuv420p", mp4Path,
    ]);

    const fileId = "thumbTestId00006";
    const result = await generateThumb(mp4Path, fileId);
    expect(result).toBe(thumbNameFor(fileId));

    const metadata = await sharp(path.join(dir, result!)).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(48);
  });

  it("returns null for a corrupt file claiming a video extension and never throws", async () => {
    const corruptPath = path.join(dir, "corrupt.mp4");
    await writeFile(corruptPath, Buffer.from("not a real mp4"));
    await expect(generateThumb(corruptPath, "thumbTestId00007")).resolves.toBeNull();
  });

  it("leaves no temp keyframe file behind after a successful video thumbnail", async () => {
    const mp4Path = path.join(dir, "clip-for-cleanup-check.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=32x32:rate=5",
      "-c:v", "libx264", "-b:v", "300k", "-pix_fmt", "yuv420p", mp4Path,
    ]);
    const fileId = "thumbTestId00008";
    await generateThumb(mp4Path, fileId);

    const framePath = path.join(os.tmpdir(), `${fileId}-thumb-frame.png`);
    const { stat } = await import("node:fs/promises");
    await expect(stat(framePath)).rejects.toThrow();
  });
});
