import { describe, expect, it } from "vitest";
import { contentDisposition, INLINE_ALLOWLIST, isInlineAllowed } from "../../src/lib/mime.ts";

describe("INLINE_ALLOWLIST", () => {
  it("is exactly the nine documented types", () => {
    expect([...INLINE_ALLOWLIST].sort()).toEqual(
      ["gif", "jpeg", "jpg", "mp4", "pdf", "png", "txt", "webm", "webp"].sort(),
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
