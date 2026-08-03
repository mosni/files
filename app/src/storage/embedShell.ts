// Reads the embeddable player route's built shell (web/dist/embed.html) ONCE at boot - the same reasoning
// as spaShell.ts (a filesystem read per request would be wasteful), but a SEPARATE file: the embed route
// must carry no <mosni-header>, no auth SDK, no mosnicat.js (H1's "no app chrome" requirement), which rules
// out reusing the SPA's own index.html shell.

import { readFileSync } from "node:fs";
import path from "node:path";

// Same tolerance spaShell.ts has for a missing web/dist - lets the server still build and boot in a test
// that never ran `vite build`.
const FALLBACK_SHELL =
  '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>';

let shell: string | undefined;

export function initEmbedShell(spaRoot: string): void {
  const embedPath = path.join(spaRoot, "embed.html");
  try {
    shell = readFileSync(embedPath, "utf8");
  } catch {
    console.warn(`storage/embedShell: ${embedPath} not found - falling back to a minimal built-in shell`);
    shell = FALLBACK_SHELL;
  }
}

export function getEmbedShell(): string {
  if (shell === undefined) {
    throw new Error("storage/embedShell: initEmbedShell() must be called before use");
  }
  return shell;
}
