// Server-rendered 404 (technical-baseline.md §2/D-10: markup lives in .tsx). Preliminary-review P1: now
// styled with the design-system chrome (.panel/.btn), softening D-54's "deliberately bare" choice. It
// still loads no auth SDK and no app JS - an error page is reachable on any path, so it stays a cheap,
// self-contained response with only the one chrome stylesheet/script.

import { renderToString } from "react-dom/server";

function NotFound() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Not found · Hannah's File Drop</title>
        <script src="https://ui.mosni.dev/mosnicat.js"></script>
      </head>
      <body>
        <main>
          <div className="panel">
            <h1>Not found</h1>
            <p>There is nothing at this address. The link may be wrong, or the file may have been deleted.</p>
            <a className="btn" href="/">
              Go to Hannah&rsquo;s File Drop
            </a>
          </div>
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
