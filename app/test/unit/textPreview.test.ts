import { describe, expect, it } from "vitest";
import { languageFor, TEXT_FULL_MAX_BYTES } from "../../src/lib/textPreview.ts";

describe("TEXT_FULL_MAX_BYTES (D-141)", () => {
  it("is 256 KB", () => {
    expect(TEXT_FULL_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("languageFor() (E5 Wave E2)", () => {
  it.each([
    ["script.js.txt", "javascript"],
    ["module.mjs.txt", "javascript"],
    ["module.cjs.txt", "javascript"],
    ["component.jsx.txt", "jsx"],
    ["app.ts.txt", "typescript"],
    ["component.tsx.txt", "tsx"],
    ["data.json.txt", "json"],
    ["page.html.txt", "markup"],
    ["page.htm.txt", "markup"],
    ["feed.xml.txt", "markup"],
    ["icon.svg.txt", "markup"],
    ["style.css.txt", "css"],
    ["style.scss.txt", "scss"],
    ["readme.md.txt", "markdown"],
    ["config.yml.txt", "yaml"],
    ["config.yaml.txt", "yaml"],
    ["run.sh.txt", "bash"],
    ["run.bash.txt", "bash"],
    ["script.py.txt", "python"],
    ["gem.rb.txt", "ruby"],
    ["main.go.txt", "go"],
    ["lib.rs.txt", "rust"],
    ["App.java.txt", "java"],
    ["main.c.txt", "c"],
    ["header.h.txt", "c"],
    ["main.cpp.txt", "cpp"],
    ["header.hpp.txt", "cpp"],
    ["Program.cs.txt", "csharp"],
    ["index.php.txt", "php"],
    ["query.sql.txt", "sql"],
  ])("maps %s to %s via its inner extension", (filename, language) => {
    expect(languageFor(filename)).toBe(language);
  });

  it("a plain .txt file with no inner extension returns null - correctly unhighlighted", () => {
    expect(languageFor("notes.txt")).toBeNull();
    expect(languageFor("README.txt")).toBeNull();
  });

  it("an unknown inner extension returns null rather than guessing", () => {
    expect(languageFor("data.wat.txt")).toBeNull();
  });

  it("matching is case-insensitive", () => {
    expect(languageFor("script.PY.TXT")).toBe("python");
  });

  it("a bare extension with no .txt suffix at all still resolves directly (general-purpose helper)", () => {
    expect(languageFor("script.py")).toBe("python");
    expect(languageFor("notes.unknownext")).toBeNull();
  });

  // Live-testing addition (2026-08-06): .md joined INLINE_ALLOWLIST directly (mime.ts), so a plain
  // "README.md" now reaches this function's direct-extension branch on its own - the `readme.md.txt`
  // double-extension case above still works too, but is no longer the only way to get highlighting.
  it("a plain .md file resolves directly, with no .txt suffix needed", () => {
    expect(languageFor("README.md")).toBe("markdown");
  });

  it("adversarial names never throw and fail to null", () => {
    expect(() => languageFor("")).not.toThrow();
    expect(languageFor("")).toBeNull();
    expect(languageFor("README")).toBeNull();
    expect(languageFor(".txt")).toBeNull(); // leading-dot-only name has no extension by this rule
  });
});
