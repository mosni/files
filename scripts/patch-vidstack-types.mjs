#!/usr/bin/env node
// E5 Wave F: @vidstack/react@0.6.15 (already recorded below-bar, D-139) ships `dist/types/index.d.ts`
// re-exporting its submodules with EXTENSIONLESS relative specifiers ("export * from './components';").
// That is invalid under this project's strict `moduleResolution: "nodenext"` (tsconfig.json) - real Node
// ESM resolution never infers an extension for a relative specifier, so `tsc --noEmit` cannot see
// `MediaPlayer`/`MediaOutlet`/`MediaCommunitySkin` (or anything else re-exported through that file) at all,
// reporting them as missing even though they exist and Vite's bundler resolution (which IS extension-
// tolerant) builds and runs the app fine.
//
// Run automatically via `npm`'s `postinstall` hook so this is reapplied after every fresh install (host,
// this Docker verify image, production) - `node_modules` is never committed. Idempotent: safe to run
// against an already-patched file.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "node_modules", "@vidstack", "react", "dist", "types", "index.d.ts");

let contents;
try {
  contents = readFileSync(target, "utf8");
} catch {
  // Not installed (e.g. a checkout that hasn't run `npm install` yet) - nothing to patch.
  process.exit(0);
}

const patched = contents.replace(
  /^(export \* from '\.\/[^']+)(');$/gm,
  (line, prefix, suffix) => (prefix.endsWith(".js") ? line : `${prefix}.js${suffix};`),
);

if (patched !== contents) {
  writeFileSync(target, patched);
  console.log(`patch-vidstack-types: added explicit .js extensions in ${path.relative(process.cwd(), target)}`);
}
