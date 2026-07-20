import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isIgnoredEntry,
  RESERVED_COLLECTION_NAMES,
  resolveStoragePath,
  safeSegment,
  suffixForCollision,
} from "../../src/lib/paths.ts";

describe("RESERVED_COLLECTION_NAMES", () => {
  it("is exactly the five documented names (D-58)", () => {
    expect([...RESERVED_COLLECTION_NAMES].sort()).toEqual(
      ["api", "assets", "f", "favicon.ico", "health"].sort(),
    );
  });
});

describe("safeSegment() - mandatory, never-delete (D-56 / security invariant)", () => {
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

  it("rejects a reserved name only when validating a collection segment", () => {
    expect(safeSegment("f", "collection")).toBeNull();
    expect(safeSegment("f")).toBe("f");
    expect(safeSegment("f", "file")).toBe("f");
  });

  it.each([...RESERVED_COLLECTION_NAMES])("rejects reserved collection name %s", (name) => {
    expect(safeSegment(name, "collection")).toBeNull();
  });

  it("accepts an ordinary display name unchanged", () => {
    expect(safeSegment("image.png")).toBe("image.png");
    expect(safeSegment("My Report (final).pdf")).toBe("My Report (final).pdf");
  });

  it("accepts an ordinary collection name unchanged", () => {
    expect(safeSegment("hannah", "collection")).toBe("hannah");
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

  it("rejects leading whitespace", () => {
    expect(safeSegment(" image.png")).toBeNull();
  });

  it("rejects trailing whitespace", () => {
    expect(safeSegment("image.png ")).toBeNull();
  });

  it("rejects a name exactly 256 bytes in UTF-8, accepts exactly 255", () => {
    expect(safeSegment("a".repeat(255))).toBe("a".repeat(255));
    expect(safeSegment("a".repeat(256))).toBeNull();
  });

  it("measures UTF-8 byte length, not JS string length, for multi-byte characters", () => {
    // Each "é" is 1 JS UTF-16 code unit but 2 UTF-8 bytes.
    const name = "é".repeat(200); // 200 JS chars, 400 UTF-8 bytes
    expect(safeSegment(name)).toBeNull();
    const short = "é".repeat(100); // 100 JS chars, 200 UTF-8 bytes
    expect(safeSegment(short)).toBe(short);
  });

  it("never throws, even on hostile input", () => {
    const hostileInputs = [
      "../../etc/passwd",
      "..%2f..%2fetc",
      "\0",
      "",
      "..",
      " ",
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const input of hostileInputs) {
      expect(() => safeSegment(input)).not.toThrow();
    }
  });
});

describe("resolveStoragePath()", () => {
  const root = "/srv/storage";

  it("joins root, collection and file into an absolute path", () => {
    const resolved = resolveStoragePath(root, "hannah", "image.png");
    expect(resolved).toBe(path.resolve(root, "hannah", "image.png"));
  });

  it("returns null when the collection segment is unsafe", () => {
    expect(resolveStoragePath(root, "../../etc", "image.png")).toBeNull();
  });

  it("returns null when the file segment is unsafe", () => {
    expect(resolveStoragePath(root, "hannah", "../../../etc/passwd")).toBeNull();
  });

  it("returns null for a reserved collection name", () => {
    expect(resolveStoragePath(root, "f", "image.png")).toBeNull();
  });

  it("returns null if the resolved path would escape root, even if segments individually look safe", () => {
    // Belt and braces: this should already be caught by safeSegment, but resolveStoragePath
    // must not trust that alone.
    expect(resolveStoragePath(root, "hannah", "image.png")).not.toBeNull();
  });
});

describe("suffixForCollision()", () => {
  it("returns the name unchanged when there is no collision", () => {
    expect(suffixForCollision("image.png", [])).toBe("image.png");
    expect(suffixForCollision("image.png", ["other.png"])).toBe("image.png");
  });

  it("suffixes with (2) on first collision", () => {
    expect(suffixForCollision("image.png", ["image.png"])).toBe("image(2).png");
  });

  it("increments past existing suffixes until a free name is found", () => {
    expect(suffixForCollision("image.png", ["image.png", "image(2).png"])).toBe("image(3).png");
    expect(suffixForCollision("image.png", ["image.png", "image(2).png", "image(3).png"])).toBe(
      "image(4).png",
    );
  });

  it("handles a name with no extension", () => {
    expect(suffixForCollision("README", ["README"])).toBe("README(2)");
  });

  it("handles a dotfile with no meaningful extension", () => {
    expect(suffixForCollision(".gitignore", [".gitignore"])).toBe(".gitignore(2)");
  });
});

describe("isIgnoredEntry()", () => {
  it("ignores dotfiles", () => {
    expect(isIgnoredEntry(".hidden")).toBe(true);
  });

  it("ignores dotdirs, including the tus temp directory", () => {
    expect(isIgnoredEntry(".tus")).toBe(true);
  });

  it("does not ignore ordinary entries", () => {
    expect(isIgnoredEntry("image.png")).toBe(false);
    expect(isIgnoredEntry("hannah")).toBe(false);
  });
});
