import { describe, expect, it } from "vitest";
import { injectHead } from "../../src/lib/shellHtml.ts";

describe("injectHead()", () => {
  it("inserts the head html immediately before the first </head>", () => {
    const shell = "<!doctype html><html><head><title>x</title></head><body><div id=\"root\"></div></body></html>";
    const result = injectHead(shell, "<meta name=\"injected\" />");
    expect(result).toBe(
      "<!doctype html><html><head><title>x</title><meta name=\"injected\" /></head><body><div id=\"root\"></div></body></html>",
    );
  });

  it("matches </head> case-insensitively", () => {
    const shell = "<html><HEAD><title>x</title></HEAD><body></body></html>";
    const result = injectHead(shell, "<meta name=\"injected\" />");
    expect(result).toBe('<html><HEAD><title>x</title><meta name="injected" /></HEAD><body></body></html>');
  });

  it("only inserts before the FIRST </head> when more than one string matches", () => {
    const shell = "<head></head><body>literal text: </head></body>";
    const result = injectHead(shell, "<X/>");
    expect(result).toBe("<head><X/></head><body>literal text: </head></body>");
  });

  it("returns the shell unchanged when there is no </head> at all", () => {
    const shell = "<html><body>no head here</body></html>";
    expect(injectHead(shell, "<meta name=\"injected\" />")).toBe(shell);
  });

  it("returns the shell unchanged for an empty string", () => {
    expect(injectHead("", "<meta />")).toBe("");
  });

  it("handles empty headHtml as a no-op insertion", () => {
    const shell = "<head></head>";
    expect(injectHead(shell, "")).toBe("<head></head>");
  });
});
