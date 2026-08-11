import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { probeMedia } from "../../src/storage/probe.ts";

const execFileAsync = promisify(execFile);

// D-74: media dimensions/text preview captured at ingest, against real sharp/ffprobe (D-45's rationale -
// a native module's behavior is exactly the class of thing that must be exercised, not assumed).
describe("probeMedia() (D-74)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "probe-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads width/height from a real PNG", async () => {
    const pngPath = path.join(dir, "photo.png");
    await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toFile(pngPath);

    const probe = await probeMedia(pngPath);
    expect(probe).toEqual({ width: 32, height: 24, durationSeconds: null, textPreview: null, isText: false });
  });

  it("an animated GIF's height is one frame's height, not every frame stacked (the pageHeight trap)", async () => {
    const gifPath = path.join(dir, "anim.gif");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1.5:size=20x14:rate=2", gifPath,
    ]);

    const rawMetadata = await sharp(gifPath, { animated: true }).metadata();
    expect(rawMetadata.pages).toBeGreaterThan(1);
    // The trap this test guards: without `pageHeight ?? height`, an animated multi-frame GIF would report
    // its stacked height (pages * frame height) instead of one frame's height.
    expect(rawMetadata.height).toBeGreaterThan(14);

    const probe = await probeMedia(gifPath);
    expect(probe.width).toBe(20);
    expect(probe.height).toBe(14);
  });

  it("reads width/height/duration from a real mp4", async () => {
    const mp4Path = path.join(dir, "clip.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x48:rate=5",
      "-c:v", "libx264", "-b:v", "500k", "-pix_fmt", "yuv420p", mp4Path,
    ]);

    const probe = await probeMedia(mp4Path);
    expect(probe.width).toBe(64);
    expect(probe.height).toBe(48);
    expect(probe.durationSeconds).not.toBeNull();
    expect(probe.durationSeconds).toBeGreaterThan(1);
    expect(probe.durationSeconds).toBeLessThan(3);
  });

  it("reads a cleaned text preview from a .txt file", async () => {
    const txtPath = path.join(dir, "notes.txt");
    await writeFile(txtPath, "  Hello,\n\tworld!  \r\nSecond line.  ");

    const probe = await probeMedia(txtPath);
    expect(probe).toEqual({
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: "Hello, world! Second line.",
      isText: true,
    });
  });

  // Live-testing addition (2026-08-06): .md joined mime.ts's text/plain mapping, and probeMedia() now
  // asks mimeTypeFor() rather than hardcoding "txt" - this proves the .md path actually gets a snippet
  // too, not just that the mapping compiles.
  it("reads a cleaned text preview from a .md file (live-testing addition)", async () => {
    const mdPath = path.join(dir, "README.md");
    await writeFile(mdPath, "# Title\n\nSome  body   text.");

    const probe = await probeMedia(mdPath);
    expect(probe).toEqual({
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: "# Title Some body text.",
      isText: true,
    });
  });

  it("truncates a long text preview to 400 characters", async () => {
    const txtPath = path.join(dir, "long.txt");
    await writeFile(txtPath, "x".repeat(1000));

    const probe = await probeMedia(txtPath);
    expect(probe.textPreview).toHaveLength(400);
  });

  it("returns all-null for a .zip - real binary bytes are not text", async () => {
    const zipPath = path.join(dir, "archive.zip");
    await writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // "PK\x03\x04" - control bytes

    const probe = await probeMedia(zipPath);
    expect(probe).toEqual({ width: null, height: null, durationSeconds: null, textPreview: null, isText: false });
  });

  // Behaviour CHANGED deliberately here (live-testing, 2026-08-06). These two files claim an image/video
  // extension, fail that probe - and then fall through to text detection, which is new. Their contents
  // ("not a real jpeg") genuinely ARE human-readable text, so under Hannah's rule they are text files with
  // a misleading name, and previewing them as text is the correct answer rather than a regression. The
  // guarantee these tests were written for is unchanged and still asserted: probeMedia never THROWS, and
  // never reports bogus dimensions.
  it("falls through to text detection for a text file claiming an image extension", async () => {
    const corruptPath = path.join(dir, "corrupt.jpg");
    await writeFile(corruptPath, Buffer.from("not a real jpeg"));

    await expect(probeMedia(corruptPath)).resolves.toEqual({
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: "not a real jpeg",
      isText: true,
    });
  });

  it("falls through to text detection for a text file claiming a video extension", async () => {
    const corruptPath = path.join(dir, "corrupt.mp4");
    await writeFile(corruptPath, Buffer.from("not a real mp4"));

    await expect(probeMedia(corruptPath)).resolves.toEqual({
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: "not a real mp4",
      isText: true,
    });
  });

  it("a GENUINELY binary file with a lying image extension stays binary, and still never throws", async () => {
    const binaryPath = path.join(dir, "actually-binary.jpg");
    await writeFile(binaryPath, Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0x00, 0x03]));

    await expect(probeMedia(binaryPath)).resolves.toEqual({
      width: null,
      height: null,
      durationSeconds: null,
      textPreview: null,
      isText: false,
    });
  });
});
