import { describe, expect, it } from "vitest";
import { mediaKindByExtension } from "../../src/lib/media.ts";

// mediaKindByExtension() is a display-only guess (previewContext.ts's kind, probe.ts's probe routing) -
// it is deliberately NOT the security-relevant classifier any more. See storage/strip.ts's content-based
// classifier for what actually decides whether metadata stripping applies (D-143).
describe("mediaKindByExtension() - extension-based media-kind guess for display/probe routing", () => {
  it.each(["jpg", "jpeg", "png", "webp", "gif"])("classifies .%s as image", (ext) => {
    expect(mediaKindByExtension(`photo.${ext}`)).toBe("image");
  });

  it.each(["mp4", "webm"])("classifies .%s as video", (ext) => {
    expect(mediaKindByExtension(`video.${ext}`)).toBe("video");
  });

  it("matching is case-insensitive", () => {
    expect(mediaKindByExtension("photo.jpg")).toBe("image");
    expect(mediaKindByExtension("photo.JPG")).toBe("image");
    expect(mediaKindByExtension("photo.Jpeg")).toBe("image");
  });

  it("video extensions are also case-insensitive", () => {
    expect(mediaKindByExtension("video.MP4")).toBe("video");
    expect(mediaKindByExtension("video.WebM")).toBe("video");
  });

  it("classifies .pdf as none - not an image or video extension", () => {
    expect(mediaKindByExtension("document.pdf")).toBe("none");
  });

  it("classifies unrelated extensions as none", () => {
    expect(mediaKindByExtension("notes.txt")).toBe("none");
  });

  it("double extensions resolve on the FINAL extension only", () => {
    expect(mediaKindByExtension("archive.tar.gz")).toBe("none");
    expect(mediaKindByExtension("photo.backup.png")).toBe("image");
  });

  it("a purely leading-dot name has no extension by this rule - fails closed, not open", () => {
    expect(mediaKindByExtension(".jpg")).toBe("none");
  });

  it("no extension at all is none", () => {
    expect(mediaKindByExtension("README")).toBe("none");
  });

  it("does not throw on empty or dots-only filenames", () => {
    expect(() => mediaKindByExtension("")).not.toThrow();
    expect(mediaKindByExtension("")).toBe("none");
    expect(() => mediaKindByExtension("..")).not.toThrow();
    expect(mediaKindByExtension("..")).toBe("none");
  });

  it("this is NOT the strip classifier - an extension that lies is not this module's concern (D-143)", () => {
    // storage/strip.ts's content-based classifier is what must still strip a GPS-bearing JPEG named
    // "photo.txt" - this module only answers "what does the name suggest" and is expected to say "none"
    // here, which is fine, because nothing security-relevant reads this function any more.
    expect(mediaKindByExtension("photo.txt")).toBe("none");
  });
});
