// Reads the SPA's built shell (web/dist/index.html) ONCE at boot - not per request, which would put a
// filesystem read on every preview hit. Filesystem access belongs in storage/ (technical-baseline.md §2).
// D-70/D-72: this is what controllers/preview.ts splices the server-rendered <head> into.

import { readFileSync } from "node:fs";
import path from "node:path";

// Same tolerance @fastify/static already has for a missing web/dist (server.ts's comment on its own
// registration): lets the server still build and boot in a test that never ran `vite build`.
const FALLBACK_SHELL =
  '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>';

let shell: string | undefined;

export function initSpaShell(spaRoot: string): void {
  const indexPath = path.join(spaRoot, "index.html");
  try {
    shell = readFileSync(indexPath, "utf8");
  } catch {
    console.warn(`storage/spaShell: ${indexPath} not found - falling back to a minimal built-in shell`);
    shell = FALLBACK_SHELL;
  }
}

export function getSpaShell(): string {
  if (shell === undefined) {
    throw new Error("storage/spaShell: initSpaShell() must be called before use");
  }
  return shell;
}
