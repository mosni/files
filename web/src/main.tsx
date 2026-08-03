import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { DropZone } from "./components/DropZone.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { PreviewPage } from "./pages/Preview.tsx";

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

// F1-F5: the drop zone was the whole landing page (D-64); E4 adds the browser BELOW it (D-1, D-93) - the
// order here is load-bearing, never swap it, and nothing may render between the two.
// D-70/D-73: the preview page is now a route inside this SPA rather than a server-rendered document.
// Declarative mode only (BrowserRouter + Routes/Route) - no createBrowserRouter, no loaders, no framework
// mode, no Vite plugin.
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <BrowserRouter>
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
      </Routes>
    </BrowserRouter>,
  );
}
