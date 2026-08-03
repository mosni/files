import { describe, expect, it } from "vitest";
import { CSP_DIRECTIVES, embedContentSecurityPolicy } from "../../src/lib/csp.ts";

describe("CSP_DIRECTIVES (shared base)", () => {
  it("keeps the standing, restrictive frame-ancestors", () => {
    expect(CSP_DIRECTIVES.frameAncestors).toEqual(["'self'", "https://files.mosni.dev"]);
  });

  it("never allows dl.mosni.dev as a script source (D-4)", () => {
    expect(CSP_DIRECTIVES.scriptSrc).not.toContain("https://dl.mosni.dev");
  });
});

describe("embedContentSecurityPolicy() (E5 Wave H, D-140)", () => {
  const csp = embedContentSecurityPolicy();
  const directive = (name: string) =>
    csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name));

  it("widens frame-ancestors to the named platform origins, never the default 'self'", () => {
    const frameAncestors = directive("frame-ancestors");
    expect(frameAncestors).toBe(
      "frame-ancestors https://twitter.com https://x.com https://discord.com " +
        "https://canary.discord.com https://ptb.discord.com",
    );
  });

  // A CSP origin match is exact - discord.com does not cover canary/ptb, which are the same application
  // on separate origins. Added in review session 034 (Hannah's call: Discord is named in Wave H's own
  // manual check, so with Twitter/X alone its player embed would simply be refused).
  it("names each Discord origin individually, since an origin match is exact", () => {
    const frameAncestors = directive("frame-ancestors") ?? "";
    for (const origin of ["https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"]) {
      expect(frameAncestors).toContain(origin);
    }
  });

  it("never emits a wildcard frame-ancestors", () => {
    expect(csp).not.toMatch(/frame-ancestors[^;]*\*/);
  });

  it("keeps every other directive identical to the standing CSP_DIRECTIVES", () => {
    expect(directive("default-src")).toBe(`default-src ${CSP_DIRECTIVES.defaultSrc.join(" ")}`);
    expect(directive("script-src")).toBe(`script-src ${CSP_DIRECTIVES.scriptSrc.join(" ")}`);
    expect(directive("connect-src")).toBe(`connect-src ${CSP_DIRECTIVES.connectSrc.join(" ")}`);
  });

  it("still forbids dl.mosni.dev as a script source (D-4 is not weakened for this route)", () => {
    expect(directive("script-src")).not.toContain("dl.mosni.dev");
  });
});
