// The first server-rendered view (technical-baseline.md §2: markup lives in .tsx, never in template
// literals - D-10). E1 ships no preview or share page yet; this error view exists because the app needs
// *some* real JSX on the server for D-44 to be proven rather than assumed, and a 404 page is the one
// server-rendered page that owes nothing to a later epic.
//
// Deliberately self-contained: no design-system script, no auth SDK, no client JS at all. An error page
// is reachable on any path, including ones a share link got wrong, so it stays the cheapest possible
// response.

import { renderToString } from "react-dom/server";

function NotFound() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Not found · Hannah's File Drop</title>
      </head>
      <body>
        <main>
          <h1>Not found</h1>
          <p>There is nothing at this address. The link may be wrong, or the file may have been deleted.</p>
        </main>
      </body>
    </html>
  );
}

// The view owns its own document rendering so the route stays a thin controller (technical-baseline.md
// §2) and markup never leaks into server.ts - which also keeps the bootstrap a .ts file, as §2 names it.
export function renderNotFoundPage(): string {
  return `<!DOCTYPE html>${renderToString(<NotFound />)}`;
}
