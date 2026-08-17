// Server-rendered 404 (technical-baseline.md §2/D-10: markup lives in .tsx). Preliminary-review P1: now
// styled with the design-system chrome (.panel/.btn), softening D-54's "deliberately bare" choice. It
// still loads no auth SDK and no app JS - an error page is reachable on any path, so it stays a cheap,
// self-contained response with only the one chrome stylesheet/script.
//
// E7.5 Wave E: <Header> (@mosni/react) replaces the raw <mosni-header> tag - a genuine win, not just
// parity. The old custom element rendered as a BARE UNSTYLED TAG on first paint (it only becomes real
// markup once mosnicat-core.js executes client-side, which an error page - no app JS at all - never
// loads); <Header> renders its real DOM synchronously under `renderToString`, so this is the first time
// the 404 page has real chrome markup on arrival rather than after a client script that this page
// deliberately never ships. `<mosni-layout>` was never actually used here (the sidebar-column reason
// index.html's own history records), so there is no Layout migration to do.

import { renderToString } from "react-dom/server";
import { Header } from "@mosni/react";

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
        {/* Same chrome shell as the SPA's index.html (header + centred main, no mosni-layout sidebar),
            so a mistyped share link doesn't land on a page that looks like a different product.
            @mosni/react ships ZERO CSS (D-R2) - the mosnicat.js tag above is still what styles this
            markup, unchanged by the migration. */}
        <Header brand="HANNAH'S" accent="FILE DROP" />
        <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "1.75rem 1.25rem" }}>
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
