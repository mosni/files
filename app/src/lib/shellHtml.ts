// Splices the server-rendered <head> block into the SPA's built shell (web/dist/index.html). Pure,
// I/O-free (technical-baseline.md §2) - reading the shell file itself is storage/spaShell.ts's job (Wave C).

const TITLE_ELEMENT = /<title>[\s\S]*?<\/title>/i;

// Inserts headHtml immediately before the FIRST </head> (case-insensitive). If there is no </head> at
// all, the shell is returned unchanged rather than guessed at - a shell that doesn't look like real HTML
// is not this function's problem to fix.
//
// The shell carries its own <title> (the drop zone's, at `/`), so when headHtml supplies one the shell's
// is REMOVED rather than left in place: a document with two <title> elements resolves to the FIRST per
// the HTML spec, so simply appending would leave every preview page showing the generic site name and
// silently discard the file-specific title. @fastify/static serves the shell for `/` without ever coming
// through here, so the drop zone's own title is unaffected.
export function injectHead(shellHtml: string, headHtml: string): string {
  const match = /<\/head>/i.exec(shellHtml);
  if (match === null) return shellHtml;

  const shell = TITLE_ELEMENT.test(headHtml) ? shellHtml.replace(TITLE_ELEMENT, "") : shellHtml;
  const idx = /<\/head>/i.exec(shell)!.index;
  return shell.slice(0, idx) + headHtml + shell.slice(idx);
}
