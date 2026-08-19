// D-215, enforced as a test rather than as a review ritual (review session 059).
//
// Hannah: *"never auto-create a collection, collections are created using the new collection button and
// not in the admin panel."* That struck D-23's "an invite creates a folder" clause and is the one thing
// E8's hand-off calls out as "calling createCollection() from anything E8 adds means you have misread the
// plan". The E8 acceptance criteria list it as AC21 - and the only way to fill that cell was a grep, which
// review session 049 established is a blank cell wearing a disguise: security invariant 6's identical
// "the review greps for it" cell survived exactly one round before a real violation shipped green.
//
// So this is the grep, as a test. It reads the admin panel's own modules and asserts none of them reaches
// for collection creation, at either end of the wire.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Every module E8 added or owns. A future file added to the admin panel belongs on this list.
const ADMIN_MODULES = [
  "app/src/controllers/admin.ts",
  "app/src/routes/admin.ts",
  "app/src/storage/grants.ts",
  "app/src/storage/usage.ts",
  "app/src/storage/diskUsage.ts",
  "app/src/lib/diskUsage.ts",
  "app/src/lib/adminContext.ts",
  "web/src/pages/Admin.tsx",
  "web/src/lib/admin.ts",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "a createCollection() call or import (server side)", pattern: /createCollection/ },
  { name: "an INSERT INTO collections (bypassing storage/collections.ts entirely)", pattern: /INSERT\s+INTO\s+collections/i },
  { name: "a POST to the collection-creation API (client side)", pattern: /["'`]\/api\/collections/ },
];

describe("D-215: the admin panel creates no collections (E8 AC21)", () => {
  it.each(ADMIN_MODULES)("%s reaches for no collection creation", (relative) => {
    const source = stripComments(readFileSync(path.join(repoRoot, relative), "utf8"));
    for (const rule of FORBIDDEN) {
      expect(rule.pattern.test(source), `${relative} contains ${rule.name}`).toBe(false);
    }
  });

  // Non-vacuity: the patterns must actually be capable of matching. Without this the whole file passes if
  // a regex is broken or a path stops resolving - the exact failure mode this test exists to replace.
  it("the patterns match the real thing when it IS present", () => {
    const real = stripComments(readFileSync(path.join(repoRoot, "app/src/storage/collections.ts"), "utf8"));
    expect(FORBIDDEN[0]!.pattern.test(real)).toBe(true);
    expect(FORBIDDEN[1]!.pattern.test(real)).toBe(true);
    const browser = stripComments(readFileSync(path.join(repoRoot, "web/src/components/FileBrowser.tsx"), "utf8"));
    expect(FORBIDDEN[2]!.pattern.test(browser)).toBe(true);
  });
});
