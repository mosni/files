import "@mosni/react/elements";
import { createRoot } from "react-dom/client";
import { Header } from "@mosni/react";
import { BrowserRouter, Route, Routes } from "react-router";
import { DropZone } from "./components/DropZone.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { UploadStack } from "./components/UploadStack.tsx";
import { PreviewPage } from "./pages/Preview.tsx";
import { AdminPage } from "./pages/Admin.tsx";
import { restorePausedUploads } from "./lib/uploads.ts";
import { initShareTarget } from "./lib/shareTarget.ts";
import { HeaderIdentity } from "./lib/headerIdentity.tsx";

// Moved out of index.html (round 4, live-testing: Hannah found dev-rationale comments shipping verbatim
// in the served page source - a .html entry file's comments survive `vite build` untouched, unlike a
// .tsx/.ts source comment, which the production minifier strips). The reasoning stays here, in source,
// where it's still readable to whoever edits index.html next, without leaking into the HTTP response.
//
// index.html's <head> loads auth.mosni.dev/sdk.js BEFORE ui.mosni.dev/mosnicat.js, deliberately
// (belt-and-braces): out of order, the chrome's toast and the auth SDK can clobber each other's
// window.mosni depending on load order. The cross-repo half of that fix already landed separately.
//
// E6 Wave G4: index.html's <head> also carries <link rel="manifest"> + <meta name="theme-color"> -
// web/embed.html gets NEITHER, deliberately: the embeddable player route is not the app and must not be
// installable.
//
// E7.5 Wave E: the header moves INTO this React tree (D-213) - <Header> (@mosni/react) renders real DOM
// React itself owns, so the D-8 class friction that kept it in the static shell (a real mosni-header
// reparents its own children on connect) no longer applies. index.html's <body> is now just
// `<div id="root">`; <Header> renders as a sibling BEFORE <main>, matching the exact structure
// app/src/views/NotFound.tsx already uses (header, then a width-capped <main>) - <Header> must NOT end up
// nested inside the width-capped <main> below, or it renders capped and centred instead of full-width.
// Accepted consequence (D-213): the header's first paint now happens after hydration instead of before -
// it used to be static markup that painted before any JS ran. mosnicat.js is still a synchronous <script>
// in <head>, so <Header>'s zero-CSS-shipped markup (@mosni/react ships no styles, D-R2) still renders
// against the real stylesheet the instant this root mounts. The preview <head> is spliced into this same
// shell (D-72), so preview documents get the chrome for free - see §E.6 of the hand-off for why that
// coupling needs its own check.

// E5 Wave G (D-133): registered defensively - a browser with no service-worker support, or one where
// registration fails, simply never gets a controller (web/src/lib/archive.ts's isArchiveSupported()/
// downloadArchive() check for exactly that), so the archive feature degrades to "unavailable" rather than
// breaking the rest of the page.
//
// ⚠ `type: "module"` is REQUIRED, not stylistic (E5 review session 034). The built worker bundles
// @zip.js/zip.js, which contains `import.meta.url`. `import.meta` is a PARSE-time syntax error in a
// classic worker script - the library's own try/catch around it cannot help, because the whole script
// fails to parse before any of it runs. Registered classically (as this shipped originally), registration
// rejected on EVERY browser, the .catch() below swallowed it, and the archive silently never worked.
// If this ever needs to go back to a classic script, the worker must be built as a non-ESM bundle
// (verified: rollup's `output.format: "iife"` emits zero `import.meta`) - changing only this line back
// re-breaks archiving everywhere.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {
    // Archive downloads stay unavailable - nothing else on this page depends on the worker. A browser
    // without module-worker support lands here; archive.ts turns that into a visible error rather than an
    // indefinite wait.
  });
}

// E6 Wave B5: restore any upload paused by a closed tab, as a `paused` job in the shared stack. Fire and
// forget - it must never block or delay first paint, and a restore failure is already swallowed inside
// the function itself (§0.5's "never throw into main.tsx's render path").
void restorePausedUploads();

// E6 Wave G6 (D-178): the Android share-target handoff. All of it lives in web/src/lib/shareTarget.ts -
// it has to WAIT for the auth SDK to settle before claiming anything, and that is too much logic (and too
// easy to get wrong, as the first version proved) to sit inline here. Returns immediately unless this load
// carries a `?share-target=<id>`.
initShareTarget();

// F1-F5: the drop zone was the whole landing page (D-64); E4 adds the browser BELOW it (D-1, D-93) - the
// order here is load-bearing, never swap it, and nothing may render between the two.
// D-70/D-73: the preview page is now a route inside this SPA rather than a server-rendered document.
// Declarative mode only (BrowserRouter + Routes/Route) - no createBrowserRouter, no loaders, no framework
// mode, no Vite plugin.
//
// E5.1 Wave E (D-161): <UploadStack /> mounts exactly ONCE, as a sibling of <Routes> rather than inside
// any one route's element - an archive started from a collection page must still show while the viewer
// navigates elsewhere (D-133's "Download all" keeps running via the service worker regardless of what's
// on screen), and the "/" route already has its own DropZone-driven jobs to show. Mounting it inside a
// per-route element would remount (and lose) the stack on every navigation; mounting it here, once, does
// not.
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <BrowserRouter>
      {/* Live-testing addition (2026-08-06): "logged in as [pic] [name]" in the header's right-side
          tagline slot - see lib/headerIdentity.tsx for HeaderIdentity itself. */}
      <Header brand="HANNAH'S" accent="FILE DROP" tagline={<HeaderIdentity />} />
      <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "1.75rem 1.25rem" }}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <DropZone />
                <FileBrowser />
              </>
            }
          />
          <Route path="/f/*" element={<PreviewPage />} />
          <Route path="/t/:token" element={<PreviewPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
        <UploadStack />
      </main>
    </BrowserRouter>,
  );
}
