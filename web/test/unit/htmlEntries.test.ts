import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Round 4 (Hannah: "there are comments left in the served html"): a .html entry file's comments ship
// VERBATIM in `vite build`'s output - unlike a .ts/.tsx source comment, which the production minifier
// strips - so any dev-rationale comment written directly in index.html/embed.html leaks into every real
// page's HTTP response body. The reasoning that used to live here moved to main.tsx/embed.tsx
// respectively; this guards against it drifting back.
const entryFile = (filename: string) =>
  readFile(path.join(import.meta.dirname, "..", "..", filename), "utf8");

describe("HTML entry files carry no comments into the shipped page (round 4)", () => {
  it.each(["index.html", "embed.html"])("%s has no HTML comments", async (filename) => {
    const html = await entryFile(filename);
    expect(html).not.toContain("<!--");
  });
});

// E7.5 AC11, added by review session 055. The hand-off named removing this <script> "the single most
// likely way to get this epic badly wrong": @mosni/react ships ZERO CSS (D-R2), so mosnicat.js is the
// only thing that styles the entire app, and E7.5 deleted every `<mosni-*>` tag from index.html - which
// makes "we don't use the design system's elements any more, drop its script" a plausible future tidy-up.
// No other gate sees it: `npm run verify` renders components in jsdom, where nothing is styled anyway.
describe("the design system's bootstrap script (E7.5 AC11)", () => {
  it("index.html loads mosnicat.js - @mosni/react ships no CSS of its own", async () => {
    expect(await entryFile("index.html")).toContain('<script src="https://ui.mosni.dev/mosnicat.js"></script>');
  });

  // The mirror image, and the reason this is two tests rather than one: embed.html must NOT have it (H1 -
  // the embeddable player is deliberately not the app). A single "both entries load the chrome" assertion
  // would be wrong here, and asserting neither would be no guard at all.
  it("embed.html does NOT load it, nor the auth SDK (H1: the embed is not the app)", async () => {
    const html = await entryFile("embed.html");
    expect(html).not.toContain("mosnicat.js");
    expect(html).not.toContain("auth.mosni.dev/sdk.js");
  });
});
