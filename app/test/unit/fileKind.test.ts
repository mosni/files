// Live-testing addition (2026-08-06, Hannah): per-kind icons in the browser listing - "an audio file
// without cover art gets a music note symbol, a code text file gets code-text icon, etc."
import { describe, expect, it } from "vitest";
import { fileKindFor } from "../../src/lib/fileKind.ts";

describe("fileKindFor() - the display kind behind a row's icon", () => {
  it("classifies real media first, whatever else the name suggests", () => {
    expect(fileKindFor("photo.png", false)).toBe("image");
    expect(fileKindFor("photo.JPEG", false)).toBe("image");
    expect(fileKindFor("clip.mp4", false)).toBe("video");
    expect(fileKindFor("clip.mkv", false)).toBe("video");
  });

  it("classifies audio by extension - the music-note case Hannah named", () => {
    for (const ext of ["mp3", "m4a", "flac", "wav", "ogg", "opus", "aac", "wma", "mid"]) {
      expect(fileKindFor(`song.${ext}`, false)).toBe("audio");
    }
  });

  it("splits detected text into code vs plain text by the extension's Prism language", () => {
    // Exactly Hannah's "syntax highlighting should be derived by ending after", reused for the icon.
    expect(fileKindFor("main.py", true)).toBe("code");
    expect(fileKindFor("app.ts", true)).toBe("code");
    expect(fileKindFor("README.md", true)).toBe("code"); // md maps to a Prism language
    expect(fileKindFor("notes.txt", true)).toBe("text");
    expect(fileKindFor("LICENSE", true)).toBe("text");
  });

  it("uses the CONTENT flag for textness, not the extension", () => {
    // A code-looking name whose bytes are not text is not a code file...
    expect(fileKindFor("main.py", false)).toBe("other");
    // ...and a text file with no extension at all still reads as text.
    expect(fileKindFor("some-file", true)).toBe("text");
  });

  it("classifies pdf and archives", () => {
    expect(fileKindFor("doc.pdf", false)).toBe("pdf");
    for (const ext of ["zip", "rar", "7z", "tar", "gz", "iso"]) {
      expect(fileKindFor(`bundle.${ext}`, false)).toBe("archive");
    }
  });

  it("falls back to 'other' for anything unrecognised, and never throws on a hostile name", () => {
    expect(fileKindFor("thing.xyzzy", false)).toBe("other");
    expect(fileKindFor("", false)).toBe("other");
    expect(fileKindFor("..", false)).toBe("other");
    expect(fileKindFor(".hidden", false)).toBe("other");
  });

  it("an image extension wins over the text flag - a real photo is never demoted to a code block", () => {
    expect(fileKindFor("photo.png", true)).toBe("image");
  });
});
