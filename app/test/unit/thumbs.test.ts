import { describe, expect, it } from "vitest";
import {
  THUMB_FORMAT,
  THUMB_MAX_EDGE,
  thumbDimensionsFor,
  thumbNameFor,
  thumbnailApplies,
} from "../../src/lib/thumbs.ts";

describe("thumbnailApplies() (D-137, amended) - images AND video", () => {
  it.each(["jpg", "jpeg", "png", "webp", "gif"])("applies to .%s", (ext) => {
    expect(thumbnailApplies(`photo.${ext}`)).toBe(true);
  });

  it.each(["mp4", "webm"])("applies to video .%s too - a keyframe grab is not a transcode (D-20/D-78)", (ext) => {
    expect(thumbnailApplies(`video.${ext}`)).toBe(true);
  });

  it("does not apply to non-media files", () => {
    expect(thumbnailApplies("document.pdf")).toBe(false);
    expect(thumbnailApplies("notes.txt")).toBe(false);
    expect(thumbnailApplies("archive.zip")).toBe(false);
  });

  it("matching is case-insensitive", () => {
    expect(thumbnailApplies("photo.PNG")).toBe(true);
  });

  it("adversarial names - no extension, leading dots, double extensions - never throw and fail closed", () => {
    expect(() => thumbnailApplies("")).not.toThrow();
    expect(thumbnailApplies("")).toBe(false);
    expect(thumbnailApplies("README")).toBe(false);
    expect(thumbnailApplies(".png")).toBe(false); // leading-dot-only name has no extension by this rule
    expect(thumbnailApplies("archive.tar.gz")).toBe(false);
    expect(thumbnailApplies("photo.backup.png")).toBe(true); // resolves on the FINAL extension only
  });
});

describe("thumbNameFor() (D-137) - deterministic, collision-free within the source's own directory", () => {
  it("names it '<fileId>-thumb.<THUMB_FORMAT>'", () => {
    expect(thumbNameFor("abc123XYZ0000000")).toBe(`abc123XYZ0000000-thumb.${THUMB_FORMAT}`);
  });

  it("is deterministic - same id always produces the same name", () => {
    expect(thumbNameFor("sameid0000000000")).toBe(thumbNameFor("sameid0000000000"));
  });

  it("distinct ids produce distinct names", () => {
    expect(thumbNameFor("idOne0000000000a")).not.toBe(thumbNameFor("idTwo0000000000b"));
  });
});

describe("THUMB_MAX_EDGE / THUMB_FORMAT", () => {
  it("is 512px longest edge, WebP (D-137)", () => {
    expect(THUMB_MAX_EDGE).toBe(512);
    expect(THUMB_FORMAT).toBe("webp");
  });
});

describe("thumbDimensionsFor() (D-137/B2) - must match sharp's real resize output exactly", () => {
  // Every pair here was checked against real sharp `.resize(512, 512, { fit: "inside", withoutEnlargement:
  // true })` output before being relied on (see the strip/thumbs session notes) - this locks that formula
  // in as a regression test, since a wrong value here silently breaks Discord's card rendering (a
  // width/height that disagrees with the actual bytes at the URL).
  it.each([
    [2000, 1000, 512, 256],
    [1000, 333, 512, 170],
    [999, 7, 512, 4],
    [333, 1000, 170, 512],
    [513, 512, 512, 511],
    [1, 1000, 1, 512],
    [701, 701, 512, 512],
  ])("scales %ix%i to %ix%i", (w, h, expectedW, expectedH) => {
    expect(thumbDimensionsFor(w, h)).toEqual({ width: expectedW, height: expectedH });
  });

  it("never enlarges a source already within THUMB_MAX_EDGE", () => {
    expect(thumbDimensionsFor(40, 30)).toEqual({ width: 40, height: 30 });
    expect(thumbDimensionsFor(512, 512)).toEqual({ width: 512, height: 512 });
  });

  it("returns null when either dimension is missing or non-positive", () => {
    expect(thumbDimensionsFor(null, 100)).toBeNull();
    expect(thumbDimensionsFor(100, null)).toBeNull();
    expect(thumbDimensionsFor(null, null)).toBeNull();
    expect(thumbDimensionsFor(0, 100)).toBeNull();
    expect(thumbDimensionsFor(100, -5)).toBeNull();
  });
});
