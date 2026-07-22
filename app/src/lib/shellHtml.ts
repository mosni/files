// Splices the server-rendered <head> block into the SPA's built shell (web/dist/index.html). Pure,
// I/O-free (technical-baseline.md §2) - reading the shell file itself is storage/spaShell.ts's job (Wave C).

// Inserts headHtml immediately before the FIRST </head> (case-insensitive). If there is no </head> at
// all, the shell is returned unchanged rather than guessed at - a shell that doesn't look like real HTML
// is not this function's problem to fix.
export function injectHead(shellHtml: string, headHtml: string): string {
  const match = /<\/head>/i.exec(shellHtml);
  if (match === null) return shellHtml;
  const idx = match.index;
  return shellHtml.slice(0, idx) + headHtml + shellHtml.slice(idx);
}
