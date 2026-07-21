import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isIgnoredEntry,
  resolveRelPath,
  safeRelPath,
  safeSegment,
  suffixForCollision,
} from "../../src/lib/paths.ts";

describe("safeSegment() - mandatory, never-delete (security invariant)", () => {
  it.each([
    ["../../etc/passwd"],
    ["..%2f..%2fetc"],
    ["a/b"],
    ["a\\b"],
    ["foo .png"],
    ["."],
    [".."],
    ["   "],
    ["a".repeat(300)],
  ])("rejects %s", (name) => {
    expect(safeSegment(name)).toBeNull();
  });

  it("accepts an ordinary display name unchanged", () => {
    expect(safeSegment("image.png")).toBe("image.png");
    expect(safeSegment("My Report (final).pdf")).toBe("My Report (final).pdf");
  });

  it("rejects the empty string", () => {
    expect(safeSegment("")).toBeNull();
  });

  it("rejects a name that is only dots", () => {
    expect(safeSegment("...")).toBeNull();
  });

  it("rejects a NUL byte anywhere in the name", () => {
    expect(safeSegment("foo\0bar")).toBeNull();
  });

  it("rejects every C0 control character and DEL", () => {
    for (let code = 0; code <= 0x1f; code++) {
      expect(safeSegment(`foo${String.fromCharCode(code)}bar`)).toBeNull();
    }
    expect(safeSegment("foo\x7fbar")).toBeNull();
  });

  it("rejects leading and trailing whitespace", () => {
    expect(safeSegment(" image.png")).toBeNull();
    expect(safeSegment("image.png ")).toBeNull();
  });

  it("rejects a name exactly 256 bytes in UTF-8, accepts exactly 255", () => {
    expect(safeSegment("a".repeat(255))).toBe("a".repeat(255));
    expect(safeSegment("a".repeat(256))).toBeNull();
  });

  it("measures UTF-8 byte length, not JS string length, for multi-byte characters", () => {
    const name = "é".repeat(200); // 200 JS chars, 400 UTF-8 bytes
    expect(safeSegment(name)).toBeNull();
    const short = "é".repeat(100); // 100 JS chars, 200 UTF-8 bytes
    expect(safeSegment(short)).toBe(short);
  });

  it("never throws, even on hostile input", () => {
    for (const input of ["../../etc/passwd", "\0", "", "..", " ", null as unknown as string]) {
      expect(() => safeSegment(input)).not.toThrow();
    }
  });
});

describe("safeRelPath() - nested paths (P6: URLs mirror the on-disk tree)", () => {
  it("accepts an arbitrarily nested path of safe segments", () => {
    expect(safeRelPath("hannah/photo.jpg")).toBe("hannah/photo.jpg");
    expect(safeRelPath("hannah/trip/2026/photo.jpg")).toBe("hannah/trip/2026/photo.jpg");
  });

  it.each([
    ["a/../b"], // .. segment - the classic traversal, now cross-segment
    ["a/./b"], // . segment
    ["a//b"], // empty middle segment (a doubled slash)
    ["/a/b"], // leading slash -> empty first segment
    ["a/b/"], // trailing slash -> empty last segment
    ["a/b\\c"], // backslash inside a segment
    ["a/foo .png"], // whitespace-adjacent-to-extension in a nested segment
    [""], // empty
  ])("rejects the unsafe nested path %s", (relPath) => {
    expect(safeRelPath(relPath)).toBeNull();
  });

  it("rejects when any single segment is oversized", () => {
    expect(safeRelPath(`ok/${"a".repeat(300)}/ok.png`)).toBeNull();
  });
});

describe("resolveRelPath()", () => {
  const root = "/srv/storage";

  it("joins root and a nested relative path into an absolute path", () => {
    expect(resolveRelPath(root, "hannah/photo.jpg")).toBe(path.resolve(root, "hannah", "photo.jpg"));
    expect(resolveRelPath(root, "a/b/c.png")).toBe(path.resolve(root, "a", "b", "c.png"));
  });

  it("returns null for a traversal path, even one that only escapes across segments", () => {
    expect(resolveRelPath(root, "../etc/passwd")).toBeNull();
    expect(resolveRelPath(root, "a/../../etc/passwd")).toBeNull();
  });

  it("stays inside root for a legitimate deep path", () => {
    const resolved = resolveRelPath(root, "a/b/c/d/e.png");
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });
});

describe("suffixForCollision()", () => {
  it("returns the name unchanged when there is no collision", () => {
    expect(suffixForCollision("image.png", [])).toBe("image.png");
    expect(suffixForCollision("image.png", ["other.png"])).toBe("image.png");
  });

  it("suffixes with (2) on first collision, incrementing past existing suffixes", () => {
    expect(suffixForCollision("image.png", ["image.png"])).toBe("image(2).png");
    expect(suffixForCollision("image.png", ["image.png", "image(2).png"])).toBe("image(3).png");
  });

  it("handles a name with no extension and a dotfile", () => {
    expect(suffixForCollision("README", ["README"])).toBe("README(2)");
    expect(suffixForCollision(".gitignore", [".gitignore"])).toBe(".gitignore(2)");
  });
});

describe("isIgnoredEntry()", () => {
  it("ignores dotfiles and dotdirs, not ordinary entries", () => {
    expect(isIgnoredEntry(".hidden")).toBe(true);
    expect(isIgnoredEntry(".tus")).toBe(true);
    expect(isIgnoredEntry("image.png")).toBe(false);
  });
});
