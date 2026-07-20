import { describe, expect, it } from "vitest";
import { stripStrategyFor } from "../../src/lib/media.ts";

describe("stripStrategyFor() - classifies filenames for metadata-stripping strategy (D-60)", () => {
  it.each(["jpg", "jpeg", "png", "webp", "gif"])("classifies .%s as image", (ext) => {
    expect(stripStrategyFor(`photo.${ext}`)).toBe("image");
  });

  it.each(["mp4", "webm"])("classifies .%s as video", (ext) => {
    expect(stripStrategyFor(`video.${ext}`)).toBe("video");
  });

  it("matching is case-insensitive", () => {
    expect(stripStrategyFor("photo.jpg")).toBe("image");
    expect(stripStrategyFor("photo.JPG")).toBe("image");
    expect(stripStrategyFor("photo.Jpeg")).toBe("image");
  });

  it("video extensions are also case-insensitive", () => {
    expect(stripStrategyFor("video.MP4")).toBe("video");
    expect(stripStrategyFor("video.WebM")).toBe("video");
  });

  it("classifies .pdf as none - documented gap, neither sharp nor ffmpeg can strip PDF metadata", () => {
    expect(stripStrategyFor("document.pdf")).toBe("none");
  });

  it("classifies unrelated extensions as none", () => {
    expect(stripStrategyFor("notes.txt")).toBe("none");
  });

  it("double extensions resolve on the FINAL extension only", () => {
    expect(stripStrategyFor("archive.tar.gz")).toBe("none");
    expect(stripStrategyFor("photo.backup.png")).toBe("image");
  });

  it("a purely leading-dot name has no extension by this rule - fails closed, not open", () => {
    expect(stripStrategyFor(".jpg")).toBe("none");
  });

  it("no extension at all is none", () => {
    expect(stripStrategyFor("README")).toBe("none");
  });

  it("does not throw on empty or dots-only filenames", () => {
    expect(() => stripStrategyFor("")).not.toThrow();
    expect(stripStrategyFor("")).toBe("none");
    expect(() => stripStrategyFor("..")).not.toThrow();
    expect(stripStrategyFor("..")).toBe("none");
  });
});
