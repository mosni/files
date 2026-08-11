import { describe, expect, it } from "vitest";
import {
  contentDisposition,
  contentDispositionFor,
  contentTypeForRecord,
  INLINE_ALLOWLIST,
  isInlineAllowed,
  isInlineAllowedFor,
  mimeTypeFor,
} from "../../src/lib/mime.ts";

describe("INLINE_ALLOWLIST", () => {
  it("is exactly the thirteen documented types (D-144 widened it with mov/m4v/mkv; live-testing added md)", () => {
    expect([...INLINE_ALLOWLIST].sort()).toEqual(
      ["gif", "jpeg", "jpg", "m4v", "md", "mkv", "mov", "mp4", "pdf", "png", "txt", "webm", "webp"].sort(),
    );
  });
});

describe("isInlineAllowed() / contentDisposition() - mandatory, never-delete (security invariant 3)", () => {
  it.each([...INLINE_ALLOWLIST])("allows %s inline", (ext) => {
    expect(isInlineAllowed(`file.${ext}`)).toBe(true);
    expect(contentDisposition(`file.${ext}`)).toBe("inline");
  });

  it("matching is case-insensitive", () => {
    expect(isInlineAllowed("photo.PNG")).toBe(true);
    expect(isInlineAllowed("photo.Png")).toBe(true);
  });

  it("anything outside the allowlist is attachment - e.g. .html, .svg", () => {
    expect(contentDisposition("page.html")).toBe("attachment");
    expect(contentDisposition("page.HTML")).toBe("attachment");
    expect(contentDisposition("icon.svg")).toBe("attachment");
  });

  it("double extensions resolve on the FINAL extension only", () => {
    expect(contentDisposition("a.png.html")).toBe("attachment");
    expect(contentDisposition("a.html.png")).toBe("inline");
  });

  it("no extension at all is attachment", () => {
    expect(contentDisposition("README")).toBe("attachment");
  });

  it("a trailing dot with nothing after it is attachment", () => {
    expect(contentDisposition("file.")).toBe("attachment");
  });

  it("a purely leading-dot name has no extension by this rule - fails closed, not open", () => {
    // Matches Node's own path.extname() convention: path.extname(".txt") === "".
    expect(contentDisposition(".txt")).toBe("attachment");
  });

  it("does not throw on empty or dots-only filenames", () => {
    expect(() => contentDisposition("")).not.toThrow();
    expect(contentDisposition("")).toBe("attachment");
    expect(() => contentDisposition("..")).not.toThrow();
    expect(contentDisposition("..")).toBe("attachment");
  });
});

describe("mimeTypeFor() (D-74)", () => {
  it.each([
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
    ["mov", "video/quicktime"],
    ["m4v", "video/x-m4v"],
    ["mkv", "video/x-matroska"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["pdf", "application/pdf"],
    ["txt", "text/plain"],
    ["md", "text/plain"],
  ])("maps .%s to %s", (ext, mime) => {
    expect(mimeTypeFor(`file.${ext}`)).toBe(mime);
  });

  it("matching is case-insensitive", () => {
    expect(mimeTypeFor("photo.PNG")).toBe("image/png");
  });

  it("falls back to application/octet-stream for unknown or missing extensions", () => {
    expect(mimeTypeFor("archive.zip")).toBe("application/octet-stream");
    expect(mimeTypeFor("README")).toBe("application/octet-stream");
    expect(mimeTypeFor("")).toBe("application/octet-stream");
  });

  // AC19e: INLINE_ALLOWLIST and MIME_TYPES must cover exactly the same extensions - an inline-allowed
  // extension with no real MIME_TYPES entry resolves to application/octet-stream, which `nosniff` then
  // blocks from ever rendering, silently defeating the allowlist (D-144's landmine).
  it("every INLINE_ALLOWLIST extension has a real (non-fallback) MIME_TYPES entry - no drift", () => {
    for (const ext of INLINE_ALLOWLIST) {
      expect(mimeTypeFor(`file.${ext}`)).not.toBe("application/octet-stream");
    }
  });
});

// Live-testing addition (2026-08-06, Hannah): whether a file previews as text is decided by its BYTES
// (lib/textDetect.ts, stored at ingest), not its extension. These are the guards on the security argument
// that lets that widen inline delivery at all - see the long note above contentTypeForRecord().
describe("content-based text delivery (security invariant 3, amended)", () => {
  const textFile = (name: string) => ({ name, isText: true });
  const binaryFile = (name: string) => ({ name, isText: false });

  it("delivers a text-detected file inline whatever it is called", () => {
    for (const name of ["notes", "README.md", "script.py", "data.weirdext", "no-extension-at-all"]) {
      expect(isInlineAllowedFor(textFile(name))).toBe(true);
      expect(contentDispositionFor(textFile(name))).toBe("inline");
    }
  });

  it("delivers a text-detected file as text/plain, never as its extension's own type", () => {
    expect(contentTypeForRecord(textFile("script.py"))).toBe("text/plain; charset=utf-8");
    expect(contentTypeForRecord(textFile("notes.md"))).toBe("text/plain; charset=utf-8");
  });

  // ⚠ THE load-bearing assertion of the whole change. .html/.svg stay off INLINE_ALLOWLIST, but a text
  // upload is inline - so the ONLY thing stopping a stored XSS is that its Content-Type is text/plain and
  // never a renderable type. With `nosniff` (set on every delivery response) that means the browser shows
  // the SOURCE. If this test ever fails, uploaded HTML is executing on dl.mosni.dev.
  it("never returns a renderable type for a text-detected file", () => {
    for (const name of ["page.html", "page.htm", "icon.svg", "feed.xml", "doc.xhtml", "app.js"]) {
      const type = contentTypeForRecord(textFile(name));
      expect(type).toBe("text/plain; charset=utf-8");
      expect(type).not.toContain("html");
      expect(type).not.toContain("svg");
      expect(type).not.toContain("xml");
      expect(type).not.toContain("javascript");
    }
  });

  it("leaves a NON-text file exactly as the extension allowlist already decided it", () => {
    expect(contentDispositionFor(binaryFile("page.html"))).toBe("attachment");
    expect(contentDispositionFor(binaryFile("icon.svg"))).toBe("attachment");
    expect(contentDispositionFor(binaryFile("archive.zip"))).toBe("attachment");
    expect(contentTypeForRecord(binaryFile("archive.zip"))).toBe("application/octet-stream");
    // ...and an allowlisted binary type is untouched by any of this.
    expect(contentDispositionFor(binaryFile("photo.png"))).toBe("inline");
    expect(contentTypeForRecord(binaryFile("photo.png"))).toBe("image/png");
  });

  it("a detected text file named .png is still served as text, not as an image", () => {
    // The extension no longer decides - which is the entire point. Serving text/plain here is strictly
    // safer than the alternative (a browser trying to decode text as a PNG).
    expect(contentTypeForRecord(textFile("actually-text.png"))).toBe("text/plain; charset=utf-8");
  });
});
