import { describe, expect, it } from "vitest";
import { contentDisposition, INLINE_ALLOWLIST, isInlineAllowed, mimeTypeFor } from "../../src/lib/mime.ts";

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
