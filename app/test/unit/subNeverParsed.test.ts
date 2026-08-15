// Security invariant 6, the "never parsed" half, enforced as a TEST rather than as a review ritual
// (review session 049).
//
// `technical-baseline.md` §1 invariant 6 and `verification-concept.md`'s never-delete list both require
// that nothing in this app parses a `sub`: no `startsWith("link:")`, no `split(":")` on one, no `LIKE` on
// a sub column. Until now that was checked only by a human running `grep` during a review - E7's AC18 and
// E7-QA1's AC18 both record it as "grep audit re-run this session", with no test behind it.
//
// It survived exactly one round. Session 048 added a `displayNameFor()` to `web/src/components/
// ShareDialog.tsx` whose whole body was `sub.startsWith("link:") ? "Invite link recipient" : sub`, to stop
// a claimed invite's raw `link:<uuid>` breaking the dialog's layout. It shipped, committed, with all 1286
// tests green, and was only caught by a later human read (commit b5ba853 reverted it). An invariant whose
// only guard is somebody remembering to grep is not guarded.
//
// The rule matters beyond tidiness: `sub` is stable across an invite-link upgrade precisely BECAUSE
// nothing derives meaning from its shape (D-191 refused an invites table for the same reason). Code that
// branches on the `link:` prefix silently becomes wrong the moment auth changes the format, and every
// test in this repo would stay green - the same silent-failure shape the E7 hand-off's own "Definition of
// done" warns about for AC11.
//
// Scope note: this scans SOURCE only (`app/src`, `web/src`). Tests may legitimately construct a `link:`
// sub as a fixture - that is not parsing.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_ROOTS = ["app/src", "web/src"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".sql"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

// Comments discuss these shapes constantly (this file's own header does) - the invariant is about CODE,
// so line comments and block-comment bodies are stripped before matching. A `--` SQL comment counts too.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*--.*$/gm, "");
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  // Any prefix/suffix/inclusion test against the one sub prefix this app constructs.
  {
    name: 'a "link:" prefix test (startsWith / endsWith / includes / indexOf / match)',
    pattern: /(startsWith|endsWith|includes|indexOf|match|search)\s*\(\s*[`'"]link:/,
  },
  // Splitting a sub into parts - the exact shape that breaks upgrade stability (invariant 22 upstream).
  { name: 'split(":") - a sub is never split into parts', pattern: /\.split\s*\(\s*[`'"]:[`'"]\s*\)/ },
  // A regex literal anchored on the prefix does the same job as startsWith and must not sneak past.
  { name: 'a regex literal matching the "link:" prefix', pattern: /\/\^?link:/ },
  // SQL: a sub column is compared with `=`, never pattern-matched. `LIKE` anywhere near one folds
  // exactly the byte-for-byte guarantee migration 008 exists to enforce.
  { name: "LIKE on a sub column", pattern: /\bLIKE\b[^\n]*\bsub\b|\bsub\b[^\n]*\bLIKE\b/i },
];

describe("security invariant 6: nothing parses a sub", () => {
  const files = SOURCE_ROOTS.flatMap((root) => sourceFiles(path.join(repoRoot, root)));

  it("scans a non-trivial number of source files (a silent zero-file scan would pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { name, pattern } of FORBIDDEN) {
    it(`no source file contains ${name}`, () => {
      const offenders = files
        .filter((file) => pattern.test(stripComments(readFileSync(file, "utf8"))))
        .map((file) => path.relative(repoRoot, file));
      expect(offenders).toEqual([]);
    });
  }

  it("the ONE construction site is still the only one, and still builds link:<id> from auth's own id", () => {
    const share = readFileSync(path.join(repoRoot, "app/src/controllers/share.ts"), "utf8");
    expect(stripComments(share)).toContain("`link:${minted.value.id}`");

    const constructionSites = files.filter((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return /[`'"]link:/.test(code);
    });
    expect(constructionSites.map((f) => path.relative(repoRoot, f))).toEqual(["app/src/controllers/share.ts"]);
  });
});
