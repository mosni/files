import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Round 4 (Hannah: "there are comments left in the served html"): a .html entry file's comments ship
// VERBATIM in `vite build`'s output - unlike a .ts/.tsx source comment, which the production minifier
// strips - so any dev-rationale comment written directly in index.html/embed.html leaks into every real
// page's HTTP response body. The reasoning that used to live here moved to main.tsx/embed.tsx
// respectively; this guards against it drifting back.
describe("HTML entry files carry no comments into the shipped page (round 4)", () => {
  it.each(["index.html", "embed.html"])("%s has no HTML comments", async (filename) => {
    const html = await readFile(path.join(import.meta.dirname, "..", "..", filename), "utf8");
    expect(html).not.toContain("<!--");
  });
});
